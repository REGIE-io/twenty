import {
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { RegieE2eWorkspaceDeletionDiscoveryService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

jest.useRealTimers();
jest.setTimeout(40 * 60_000);

const RUN_ACCEPTANCE =
  process.env.RUN_WORKSPACE_DELETION_BACKFILL_REAPER_ACCEPTANCE === 'true';
const describeAcceptance = RUN_ACCEPTANCE ? describe : describe.skip;
const RECOVERY_LIMIT = 5;
const ADMISSION_LIMIT = 15;

type Inventory = {
  count: number | string;
  fingerprint: string | null;
};

type Target = {
  workspaceId: string;
};

describeAcceptance('workspace deletion backfill reaper acceptance', () => {
  it('drains every quarantined marker-safe E2E workspace and preserves all controls', async () => {
    const simulatedNow = new Date(
      Date.now() + REGIE_E2E_PURGE_GRACE_PERIOD_MS + 5 * 60_000,
    );
    const cutoff = new Date(
      simulatedNow.getTime() - REGIE_E2E_PURGE_GRACE_PERIOD_MS,
    );
    const discovery =
      getAppProviderByClassName<RegieE2eWorkspaceDeletionDiscoveryService>(
        'RegieE2eWorkspaceDeletionDiscoveryService',
      );
    const queue = getAppProviderByClassName<WorkspaceDeletionQueueAdapter>(
      'WorkspaceDeletionQueueAdapter',
    );
    const targets = await global.testDataSource.query<Target[]>(
      `SELECT workspace.id AS "workspaceId"
         FROM core."keyValuePair" marker
         JOIN core.workspace workspace ON workspace.id = marker."workspaceId"
        WHERE marker.key = $1
          AND marker.type = 'USER_VARIABLE'
          AND marker.value ->> 'ephemeral' = 'true'
          AND marker.value ->> 'organizationId' LIKE 'org\_e2e\_%' ESCAPE '\'
          AND marker.value ->> 'workspaceSlug' = workspace.subdomain
          AND workspace.subdomain LIKE 'org-e2e-%'
          AND workspace."deletedAt" <= $2
          AND workspace."deletionRequestedAt" IS NULL
        ORDER BY workspace."deletedAt" ASC, workspace.id ASC`,
      [REGIE_E2E_WORKSPACE_MARKER_KEY, cutoff],
    );

    if (targets.length === 0) {
      throw new Error(
        'Refusing backfill acceptance run: no marker-safe quarantined E2E workspaces were found',
      );
    }

    const targetIds = targets.map(({ workspaceId }) => workspaceId);
    const schemaNames = targetIds.map(getWorkspaceSchemaName);
    const [controlInventoryBefore] = await global.testDataSource.query<
      Inventory[]
    >(
      `SELECT count(*) AS count,
                md5(string_agg(id::text, ',' ORDER BY id)) AS fingerprint
           FROM core.workspace
          WHERE NOT (id = ANY($1::uuid[]))`,
      [targetIds],
    );
    let admitted = 0;
    let recovered = 0;
    let rounds = 0;
    let previousRemaining = targets.length + 1;

    while (rounds < 20) {
      const remainingBefore = await global.testDataSource.query<Target[]>(
        'SELECT id AS "workspaceId" FROM core.workspace WHERE id = ANY($1::uuid[])',
        [targetIds],
      );

      if (remainingBefore.length === 0) {
        break;
      }
      if (remainingBefore.length >= previousRemaining) {
        throw new Error(
          `Reaper made no progress: ${remainingBefore.length} targets remain after ${rounds} rounds`,
        );
      }
      previousRemaining = remainingBefore.length;

      const result = await discovery.discover(queue, {
        now: new Date(simulatedNow.getTime() + rounds * 31_000),
        gracePeriodMs: REGIE_E2E_PURGE_GRACE_PERIOD_MS,
        staleAfterMs: 30_000,
        recoveryLimit: RECOVERY_LIMIT,
        admissionLimit: ADMISSION_LIMIT,
      });

      admitted += result.admitted;
      recovered += result.recovered;
      rounds += 1;
      await waitForAllJobsToFinish();
    }

    const remainingTargets = await global.testDataSource.query<Target[]>(
      'SELECT id AS "workspaceId" FROM core.workspace WHERE id = ANY($1::uuid[])',
      [targetIds],
    );
    const remainingSchemas = await global.testDataSource.query<
      Array<{ schemaName: string | null }>
    >(
      `SELECT to_regnamespace(schema_name)::text AS "schemaName"
         FROM unnest($1::text[]) schema_name`,
      [schemaNames],
    );
    const [ownedRows] = await global.testDataSource.query<
      Array<{
        memberships: number;
        objects: number;
        fields: number;
        keyValues: number;
      }>
    >(
      `SELECT
        (SELECT count(*)::int FROM core."userWorkspace" WHERE "workspaceId" = ANY($1::uuid[])) AS memberships,
        (SELECT count(*)::int FROM core."objectMetadata" WHERE "workspaceId" = ANY($1::uuid[])) AS objects,
        (SELECT count(*)::int FROM core."fieldMetadata" WHERE "workspaceId" = ANY($1::uuid[])) AS fields,
        (SELECT count(*)::int FROM core."keyValuePair" WHERE "workspaceId" = ANY($1::uuid[])) AS "keyValues"`,
      [targetIds],
    );
    const [controlInventoryAfter] = await global.testDataSource.query<
      Inventory[]
    >(
      `SELECT count(*) AS count,
                md5(string_agg(id::text, ',' ORDER BY id)) AS fingerprint
           FROM core.workspace`,
    );

    // Machine-readable evidence for the restored-database validation run.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: 'workspace_deletion_backfill_reaper_acceptance_finished',
        identified: targets.length,
        admitted,
        recovered,
        rounds,
        deleted: targets.length - remainingTargets.length,
        remainingSchemas: remainingSchemas.filter(
          ({ schemaName }) => schemaName !== null,
        ).length,
        remainingOwnedRows: ownedRows,
        controlsPreserved:
          Number(controlInventoryAfter.count) ===
            Number(controlInventoryBefore.count) &&
          controlInventoryAfter.fingerprint ===
            controlInventoryBefore.fingerprint,
      }),
    );

    expect(remainingTargets).toHaveLength(0);
    expect(admitted + recovered).toBeGreaterThanOrEqual(targets.length);
    expect(
      remainingSchemas.every(({ schemaName }) => schemaName === null),
    ).toBe(true);
    expect(ownedRows).toEqual({
      memberships: 0,
      objects: 0,
      fields: 0,
      keyValues: 0,
    });
    expect(Number(controlInventoryAfter.count)).toBe(
      Number(controlInventoryBefore.count),
    );
    expect(controlInventoryAfter.fingerprint).toBe(
      controlInventoryBefore.fingerprint,
    );
  });
});
