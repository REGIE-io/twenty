import crypto from 'crypto';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import {
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { type InternalWorkspaceProvisioningService } from 'src/engine/core-modules/auth/services/internal-workspace-provisioning.service';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { WorkspaceDeletionKind } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type RegieE2eWorkspaceDeletionDiscoveryJob } from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { type WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

jest.useRealTimers();
jest.setTimeout(15 * 60_000);

const RUN_ACCEPTANCE =
  process.env.RUN_WORKSPACE_DELETION_DIRECT_ACCEPTANCE === 'true';
const describeAcceptance = RUN_ACCEPTANCE ? describe : describe.skip;
const RECOVERY_COUNT = 15;
const FRESH_COUNT = 15;
const EXPECTED_DELETION_COUNT = RECOVERY_COUNT + FRESH_COUNT;

type Fixture = {
  workspaceId: string;
  schemaName: string;
};

describeAcceptance('direct workspace deletion acceptance', () => {
  const fixtures: Fixture[] = [];
  const controls: Fixture[] = [];

  const provision = async ({
    runId,
    index,
    ephemeral,
    e2eSlug = ephemeral,
  }: {
    runId: string;
    index: number;
    ephemeral: boolean;
    e2eSlug?: boolean;
  }): Promise<Fixture> => {
    const provisioning =
      getAppProviderByClassName<InternalWorkspaceProvisioningService>(
        'InternalWorkspaceProvisioningService',
      );
    const suffix = `${runId}-${index.toString().padStart(2, '0')}`;
    const slug = e2eSlug
      ? `org-e2e-direct-${suffix}`
      : `customer-direct-${suffix}`;
    const workspace = await provisioning.createWorkspace({
      name: `Direct deletion acceptance ${suffix}`,
      slug,
      ephemeral,
      organizationId: ephemeral ? `org_e2e_direct_${suffix}` : undefined,
    });

    return {
      workspaceId: workspace.workspaceId,
      schemaName: getWorkspaceSchemaName(workspace.workspaceId),
    };
  };

  const cleanupFixture = async ({ workspaceId, schemaName }: Fixture) => {
    await global.testDataSource.query(
      `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
    );
    await global.testDataSource.query(
      'DELETE FROM core.workspace WHERE id = $1',
      [workspaceId],
    );
  };

  beforeAll(async () => {
    const queryRunner = global.testDataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await new AddWorkspaceDeletionLifecycleFastInstanceCommand().up(
        queryRunner,
      );
    } finally {
      await queryRunner.release();
    }
  });

  afterAll(async () => {
    for (const fixture of [...fixtures, ...controls]) {
      await cleanupFixture(fixture);
    }
  });

  it('deletes 15 recovery and 15 fresh workspaces through the real queue without cron registration', async () => {
    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const now = new Date();
    const cutoff = new Date(now.getTime() - REGIE_E2E_PURGE_GRACE_PERIOD_MS);
    const lifecycleStore =
      getAppProviderByClassName<WorkspaceDeletionLifecycleStore>(
        'WorkspaceDeletionLifecycleStore',
      );
    const discoveryJob =
      getAppProviderByClassName<RegieE2eWorkspaceDeletionDiscoveryJob>(
        'RegieE2eWorkspaceDeletionDiscoveryJob',
      );
    const monitoring =
      getAppProviderByClassName<WorkspaceDeletionMonitoringService>(
        'WorkspaceDeletionMonitoringService',
      );
    const trace = getAppProviderByClassName<WorkspaceDeletionTraceService>(
      'WorkspaceDeletionTraceService',
    );
    const metrics = getAppProviderByClassName<MetricsService>('MetricsService');
    const config = getAppProviderByClassName<TwentyConfigService>(
      'TwentyConfigService',
    );
    const traceSpy = jest.spyOn(trace, 'record');
    const metricSpy = jest.spyOn(metrics, 'incrementCounterForEvent');

    if (config.get('REGIE_E2E_WORKSPACE_DELETION_CRON_ENABLED')) {
      throw new Error(
        'Refusing direct acceptance run while workspace deletion cron registration is enabled',
      );
    }

    const unrelatedEligible = await global.testDataSource.query<
      Array<{ workspaceId: string }>
    >(
      `SELECT workspace.id AS "workspaceId"
         FROM core."keyValuePair" marker
         JOIN core.workspace workspace ON workspace.id = marker."workspaceId"
        WHERE marker.key = $1
          AND marker.type = 'USER_VARIABLE'
          AND marker.value ->> 'ephemeral' = 'true'
          AND marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'
          AND workspace.subdomain LIKE 'org-e2e-%'
          AND workspace."deletedAt" <= $2`,
      [REGIE_E2E_WORKSPACE_MARKER_KEY, cutoff],
    );

    if (unrelatedEligible.length > 0) {
      throw new Error(
        `Refusing direct acceptance run: ${unrelatedEligible.length} unrelated eligible workspace(s) already exist`,
      );
    }

    const unrelatedOutstanding =
      await lifecycleStore.findOutstandingDeletions();

    if (unrelatedOutstanding.length > 0) {
      throw new Error(
        `Refusing direct acceptance run: ${unrelatedOutstanding.length} unrelated outstanding deletion(s) already exist`,
      );
    }

    try {
      for (let index = 0; index < EXPECTED_DELETION_COUNT; index += 1) {
        fixtures.push(
          await provision({ runId, index, ephemeral: true, e2eSlug: true }),
        );
      }

      controls.push(
        await provision({
          runId,
          index: EXPECTED_DELETION_COUNT,
          ephemeral: false,
          e2eSlug: false,
        }),
      );
      controls.push(
        await provision({
          runId,
          index: EXPECTED_DELETION_COUNT + 1,
          ephemeral: false,
          e2eSlug: true,
        }),
      );

      const recoveryFixtures = fixtures.slice(0, RECOVERY_COUNT);
      const freshFixtures = fixtures.slice(RECOVERY_COUNT);
      const recoveryIds = recoveryFixtures.map(
        ({ workspaceId }) => workspaceId,
      );
      const freshIds = freshFixtures.map(({ workspaceId }) => workspaceId);
      const controlIds = controls.map(({ workspaceId }) => workspaceId);

      await global.testDataSource.query(
        `UPDATE core.workspace
            SET "activationStatus" = 'SUSPENDED',
                "deletedAt" = $2
          WHERE id = ANY($1::uuid[])`,
        [freshIds, new Date(cutoff.getTime() - 120_000)],
      );
      await global.testDataSource.query(
        `UPDATE core.workspace
            SET "activationStatus" = 'SUSPENDED',
                "deletedAt" = $2
          WHERE id = ANY($1::uuid[])`,
        [recoveryIds, new Date(cutoff.getTime() - 60_000)],
      );
      await global.testDataSource.query(
        `UPDATE core.workspace
            SET "activationStatus" = 'SUSPENDED',
                "deletedAt" = $2
          WHERE id = $1`,
        [controls[1].workspaceId, new Date(cutoff.getTime() - 180_000)],
      );

      const staleRequestTime = new Date(now.getTime() - 60_000);

      for (const { workspaceId } of recoveryFixtures) {
        await expect(
          lifecycleStore.requestDeletion(
            workspaceId,
            WorkspaceDeletionKind.E2E,
            staleRequestTime,
          ),
        ).resolves.not.toBeNull();
      }

      const startedAt = Date.now();
      const completedAtByWorkspace = new Map<string, number>();
      const discovery = await discoveryJob.handle(now);
      const deadline = startedAt + 10 * 60_000;

      expect(discovery).toEqual({
        recovered: RECOVERY_COUNT,
        admitted: FRESH_COUNT,
      });

      while (
        completedAtByWorkspace.size < EXPECTED_DELETION_COUNT &&
        Date.now() < deadline
      ) {
        const remaining = await global.testDataSource.query<
          Array<{ id: string }>
        >('SELECT id FROM core.workspace WHERE id = ANY($1::uuid[])', [
          fixtures.map(({ workspaceId }) => workspaceId),
        ]);
        const remainingIds = new Set(remaining.map(({ id }) => id));

        for (const { workspaceId } of fixtures) {
          if (
            !remainingIds.has(workspaceId) &&
            !completedAtByWorkspace.has(workspaceId)
          ) {
            completedAtByWorkspace.set(workspaceId, Date.now());
          }
        }

        if (remaining.length > 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      await waitForAllJobsToFinish();

      const elapsedMs = [...completedAtByWorkspace.values()]
        .map((completedAt) => completedAt - startedAt)
        .sort((left, right) => left - right);
      const meanMs =
        elapsedMs.reduce((total, duration) => total + duration, 0) /
        elapsedMs.length;
      const variance =
        elapsedMs.reduce(
          (total, duration) => total + (duration - meanMs) ** 2,
          0,
        ) / elapsedMs.length;
      const standardDeviationMs = Math.sqrt(variance);
      const p95Ms = elapsedMs[Math.ceil(elapsedMs.length * 0.95) - 1];
      const targetIds = new Set(fixtures.map(({ workspaceId }) => workspaceId));
      const traces = traceSpy.mock.calls.map(([entry]) => entry);
      const finishedTraces = traces.filter(
        (entry) =>
          entry.event === 'workspace_deletion_finished' &&
          entry.workspaceId !== undefined &&
          targetIds.has(entry.workspaceId),
      );
      const failedTraces = traces.filter(
        (entry) =>
          entry.event === 'workspace_deletion_failed' &&
          entry.workspaceId !== undefined &&
          targetIds.has(entry.workspaceId),
      );
      const completedMetrics = metricSpy.mock.calls.filter(
        ([entry]) => entry.key === MetricsKeys.WorkspaceDeletionCompleted,
      );
      const failedMetrics = metricSpy.mock.calls.filter(
        ([entry]) => entry.key === MetricsKeys.WorkspaceDeletionFailed,
      );
      const report = await monitoring.report(new Date(), 30_000);
      const catalogRows = await global.testDataSource.query<
        Array<{ schemaName: string | null }>
      >(
        `SELECT to_regnamespace(schema_name)::text AS "schemaName"
           FROM unnest($1::text[]) schema_name`,
        [fixtures.map(({ schemaName }) => schemaName)],
      );
      const remainingOwnedRows = await global.testDataSource.query<
        Array<{
          workspaces: number;
          memberships: number;
          objects: number;
          fields: number;
          keyValues: number;
        }>
      >(
        `SELECT
          (SELECT count(*)::int FROM core.workspace WHERE id = ANY($1::uuid[])) AS workspaces,
          (SELECT count(*)::int FROM core."userWorkspace" WHERE "workspaceId" = ANY($1::uuid[])) AS memberships,
          (SELECT count(*)::int FROM core."objectMetadata" WHERE "workspaceId" = ANY($1::uuid[])) AS objects,
          (SELECT count(*)::int FROM core."fieldMetadata" WHERE "workspaceId" = ANY($1::uuid[])) AS fields,
          (SELECT count(*)::int FROM core."keyValuePair" WHERE "workspaceId" = ANY($1::uuid[])) AS "keyValues"`,
        [fixtures.map(({ workspaceId }) => workspaceId)],
      );
      const controlRows = await global.testDataSource.query<
        Array<{ id: string }>
      >('SELECT id FROM core.workspace WHERE id = ANY($1::uuid[])', [
        controlIds,
      ]);

      // This is the machine-readable artifact emitted by the manual acceptance lane.
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: 'workspace_deletion_direct_acceptance_finished',
          runId,
          recovered: discovery.recovered,
          admitted: discovery.admitted,
          completed: completedAtByWorkspace.size,
          totalDurationMs: Date.now() - startedAt,
          meanCompletionMs: Math.round(meanMs),
          standardDeviationMs: Math.round(standardDeviationMs),
          twoStandardDeviationsMs: Math.round(meanMs + 2 * standardDeviationMs),
          p95CompletionMs: p95Ms,
          maxCompletionMs: elapsedMs.at(-1),
          completedTraceCount: finishedTraces.length,
          failedTraceCount: failedTraces.length,
          completedMetricCount: completedMetrics.length,
          failedMetricCount: failedMetrics.length,
          outstandingDeletionCount: report.summary.outstanding,
        }),
      );

      expect(completedAtByWorkspace.size).toBe(EXPECTED_DELETION_COUNT);
      expect(elapsedMs.at(-1)).toBeLessThan(10 * 60_000);
      expect(finishedTraces).toHaveLength(EXPECTED_DELETION_COUNT);
      expect(failedTraces).toHaveLength(0);
      expect(completedMetrics).toHaveLength(EXPECTED_DELETION_COUNT);
      expect(failedMetrics).toHaveLength(0);
      expect(
        report.rows.filter(({ workspaceId }) => targetIds.has(workspaceId)),
      ).toHaveLength(0);
      expect(catalogRows.every(({ schemaName }) => schemaName === null)).toBe(
        true,
      );
      expect(remainingOwnedRows).toEqual([
        {
          workspaces: 0,
          memberships: 0,
          objects: 0,
          fields: 0,
          keyValues: 0,
        },
      ]);
      expect(controlRows.map(({ id }) => id).sort()).toEqual(controlIds.sort());
    } finally {
      traceSpy.mockRestore();
      metricSpy.mockRestore();
    }
  });
});
