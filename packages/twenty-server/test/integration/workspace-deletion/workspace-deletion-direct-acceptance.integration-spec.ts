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
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { getQueueToken } from 'src/engine/core-modules/message-queue/utils/get-queue-token.util';
import { WorkspaceDeletionKind } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import {
  REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  RegieE2eWorkspaceDeletionDiscoveryJob,
} from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { type WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';
import { WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

jest.useRealTimers();
jest.setTimeout(25 * 60_000);

const RUN_ACCEPTANCE =
  process.env.RUN_WORKSPACE_DELETION_DIRECT_ACCEPTANCE === 'true';
const USE_EXISTING_ELIGIBLE_WORKSPACES =
  process.env.WORKSPACE_DELETION_ACCEPTANCE_USE_EXISTING === 'true';
const RUN_THROUGH_CRON =
  process.env.WORKSPACE_DELETION_ACCEPTANCE_VIA_CRON === 'true';
const describeAcceptance = RUN_ACCEPTANCE ? describe : describe.skip;
const RECOVERY_COUNT = 5;
const FRESH_COUNT = 15;
const EXPECTED_DELETION_COUNT = RECOVERY_COUNT + FRESH_COUNT;

type Fixture = {
  workspaceId: string;
  schemaName: string;
};

describeAcceptance('workspace deletion acceptance', () => {
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
    if (USE_EXISTING_ELIGIBLE_WORKSPACES) {
      return;
    }

    for (const fixture of [...fixtures, ...controls]) {
      await cleanupFixture(fixture);
    }
  });

  it('deletes 5 recovery and 15 fresh workspaces through the real queue', async () => {
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
    const cronQueue = global.app.get<MessageQueueService>(
      getQueueToken(MessageQueue.cronQueue),
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
    const timedTraces: Array<{
      trace: Parameters<WorkspaceDeletionTraceService['record']>[0];
      recordedAt: number;
    }> = [];
    const originalRecord = trace.record.bind(trace);
    const traceSpy = jest.spyOn(trace, 'record').mockImplementation((entry) => {
      timedTraces.push({ trace: entry, recordedAt: Date.now() });
      originalRecord(entry);
    });
    const metricSpy = jest.spyOn(metrics, 'incrementCounterForEvent');

    if (
      config.get('REGIE_E2E_WORKSPACE_DELETION_CRON_ENABLED') !==
      RUN_THROUGH_CRON
    ) {
      throw new Error(
        `Refusing acceptance run: cron configuration does not match requested mode ${RUN_THROUGH_CRON}`,
      );
    }

    const existingEligible = await global.testDataSource.query<
      Array<{ workspaceId: string; deletedAt: Date }>
    >(
      `SELECT workspace.id AS "workspaceId",
              workspace."deletedAt" AS "deletedAt"
         FROM core."keyValuePair" marker
         JOIN core.workspace workspace ON workspace.id = marker."workspaceId"
        WHERE marker.key = $1
          AND marker.type = 'USER_VARIABLE'
          AND marker.value ->> 'ephemeral' = 'true'
          AND marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'
          AND marker.value ->> 'workspaceSlug' = workspace.subdomain
          AND workspace.subdomain LIKE 'org-e2e-%'
          AND workspace."deletedAt" <= $2
        ORDER BY workspace."deletedAt" ASC, workspace.id ASC`,
      [REGIE_E2E_WORKSPACE_MARKER_KEY, cutoff],
    );

    if (!USE_EXISTING_ELIGIBLE_WORKSPACES && existingEligible.length > 0) {
      throw new Error(
        `Refusing direct acceptance run: ${existingEligible.length} unrelated eligible workspace(s) already exist`,
      );
    }

    const outstandingAtStart = await lifecycleStore.findOutstandingDeletions();
    const hasUnsafeOutstanding = outstandingAtStart.some(
      ({ deletionKind }) => deletionKind !== WorkspaceDeletionKind.E2E,
    );

    if (
      outstandingAtStart.length > 0 &&
      (!USE_EXISTING_ELIGIBLE_WORKSPACES || hasUnsafeOutstanding)
    ) {
      throw new Error(
        `Refusing acceptance run: ${outstandingAtStart.length} unsafe outstanding deletion(s) already exist`,
      );
    }
    if (outstandingAtStart.length > EXPECTED_DELETION_COUNT) {
      throw new Error(
        `Refusing acceptance run: ${outstandingAtStart.length} outstanding deletions exceed the ${EXPECTED_DELETION_COUNT}-workspace assertion`,
      );
    }
    if (RUN_THROUGH_CRON && outstandingAtStart.length > RECOVERY_COUNT) {
      throw new Error(
        `Refusing one-pass cron acceptance run: ${outstandingAtStart.length} outstanding deletions exceed the recovery limit ${RECOVERY_COUNT}`,
      );
    }

    try {
      if (USE_EXISTING_ELIGIBLE_WORKSPACES) {
        const outstandingIds = new Set(
          outstandingAtStart.map(({ workspaceId }) => workspaceId),
        );
        const freshCandidates = existingEligible.filter(
          ({ workspaceId }) => !outstandingIds.has(workspaceId),
        );
        const freshTargetCount =
          EXPECTED_DELETION_COUNT - outstandingAtStart.length;

        if (freshCandidates.length < freshTargetCount + 1) {
          throw new Error(
            `Refusing existing-workspace acceptance run: expected at least ${freshTargetCount + 1} fresh eligible workspaces but found ${freshCandidates.length}`,
          );
        }

        fixtures.push(
          ...outstandingAtStart.map(({ workspaceId }) => ({
            workspaceId,
            schemaName: getWorkspaceSchemaName(workspaceId),
          })),
          ...freshCandidates
            .slice(0, freshTargetCount)
            .map(({ workspaceId }) => ({
              workspaceId,
              schemaName: getWorkspaceSchemaName(workspaceId),
            })),
        );
        controls.push(
          ...freshCandidates.slice(freshTargetCount).map(({ workspaceId }) => ({
            workspaceId,
            schemaName: getWorkspaceSchemaName(workspaceId),
          })),
        );
      } else {
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
      }

      let recoveryFixtures: Fixture[];
      let freshFixtures: Fixture[];

      if (USE_EXISTING_ELIGIBLE_WORKSPACES) {
        if (outstandingAtStart.length > 0) {
          recoveryFixtures = fixtures.slice(0, outstandingAtStart.length);
          freshFixtures = fixtures.slice(outstandingAtStart.length);
        } else {
          // Existing rows are ordered oldest first. Keep the oldest 15 untouched
          // for fresh admission, then stage five stale recovery rows.
          recoveryFixtures = fixtures.slice(FRESH_COUNT);
          freshFixtures = fixtures.slice(0, FRESH_COUNT);
        }
      } else {
        recoveryFixtures = fixtures.slice(0, RECOVERY_COUNT);
        freshFixtures = fixtures.slice(RECOVERY_COUNT);
      }
      const recoveryIds = recoveryFixtures.map(
        ({ workspaceId }) => workspaceId,
      );
      const freshIds = freshFixtures.map(({ workspaceId }) => workspaceId);
      const controlIds = controls.map(({ workspaceId }) => workspaceId);

      if (!USE_EXISTING_ELIGIBLE_WORKSPACES) {
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
      }

      const staleRequestTime = new Date(now.getTime() - 60_000);

      if (outstandingAtStart.length === 0) {
        for (const { workspaceId } of recoveryFixtures) {
          await expect(
            lifecycleStore.requestDeletion(
              workspaceId,
              WorkspaceDeletionKind.E2E,
              staleRequestTime,
            ),
          ).resolves.not.toBeNull();
        }
      }

      let startedAt = Date.now();
      const completedAtByWorkspace = new Map<string, number>();
      let completionDeadline = startedAt + 10 * 60_000;
      let recovered = 0;
      let admitted = 0;
      let discoveryRounds = 0;

      if (RUN_THROUGH_CRON) {
        const cronDeadline = startedAt + 11 * 60_000;

        await cronQueue.addCron({
          jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
          data: undefined,
          options: {
            repeat: { pattern: REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN },
          },
        });

        while (
          !timedTraces.some(
            ({ trace: entry }) =>
              entry.event === 'workspace_deletion_discovery_finished',
          ) &&
          Date.now() < cronDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        await cronQueue.removeCron({
          jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
        });

        const completedDiscovery = timedTraces.find(
          ({ trace: entry }) =>
            entry.event === 'workspace_deletion_discovery_finished',
        );

        if (completedDiscovery === undefined) {
          throw new Error(
            'Workspace deletion discovery cron did not fire before the acceptance deadline',
          );
        }

        const discoveryTrace = completedDiscovery.trace;

        startedAt = completedDiscovery.recordedAt;
        completionDeadline = startedAt + 10 * 60_000;
        recovered = discoveryTrace.recovered ?? 0;
        admitted = discoveryTrace.admitted ?? 0;
        discoveryRounds = 1;
      }

      while (
        completedAtByWorkspace.size < EXPECTED_DELETION_COUNT &&
        Date.now() < completionDeadline
      ) {
        let discovery = { recovered: 0, admitted: 0 };

        if (!RUN_THROUGH_CRON) {
          discovery = await discoveryJob.runAt(new Date());
          recovered += discovery.recovered;
          admitted += discovery.admitted;
          discoveryRounds += 1;
        }

        await waitForAllJobsToFinish();

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
          if (discovery.recovered === 0 && discovery.admitted === 0) {
            await new Promise((resolve) => setTimeout(resolve, 31_000));
          }
        }
      }

      await waitForAllJobsToFinish();

      expect({ recovered, admitted }).toEqual({
        recovered:
          outstandingAtStart.length === 0
            ? RECOVERY_COUNT
            : outstandingAtStart.length,
        admitted:
          outstandingAtStart.length === 0
            ? FRESH_COUNT
            : EXPECTED_DELETION_COUNT - outstandingAtStart.length,
      });

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
      const maxCompletionMs = elapsedMs[elapsedMs.length - 1] ?? 0;
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
      const startedAtByWorkspace = new Map(
        timedTraces
          .filter(
            ({ trace: entry }) =>
              entry.event === 'workspace_deletion_started' &&
              entry.workspaceId !== undefined &&
              targetIds.has(entry.workspaceId),
          )
          .map(({ trace: entry, recordedAt }) => [
            entry.workspaceId as string,
            recordedAt,
          ]),
      );
      const deletionDurationsMs = timedTraces
        .filter(
          ({ trace: entry }) =>
            entry.event === 'workspace_deletion_finished' &&
            entry.workspaceId !== undefined &&
            targetIds.has(entry.workspaceId),
        )
        .map(({ trace: entry, recordedAt }) =>
          Math.max(
            0,
            recordedAt - startedAtByWorkspace.get(entry.workspaceId!)!,
          ),
        );
      const meanDeletionDurationMs =
        deletionDurationsMs.reduce((total, duration) => total + duration, 0) /
        deletionDurationsMs.length;
      const deletionDurationStandardDeviationMs = Math.sqrt(
        deletionDurationsMs.reduce(
          (total, duration) => total + (duration - meanDeletionDurationMs) ** 2,
          0,
        ) / deletionDurationsMs.length,
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
          inputMode: USE_EXISTING_ELIGIBLE_WORKSPACES
            ? 'existing-eligible'
            : 'generated-fixtures',
          initialEligibleCount: existingEligible.length,
          preservedEligibleControlCount: USE_EXISTING_ELIGIBLE_WORKSPACES
            ? controls.length
            : undefined,
          initialOutstandingCount: outstandingAtStart.length,
          discoveryRounds,
          recovered,
          admitted,
          completed: completedAtByWorkspace.size,
          totalDurationMs: Date.now() - startedAt,
          meanQueueCompletionMs: Math.round(meanMs),
          queueCompletionStandardDeviationMs: Math.round(standardDeviationMs),
          queueCompletionTwoStandardDeviationsMs: Math.round(
            meanMs + 2 * standardDeviationMs,
          ),
          p95CompletionMs: p95Ms,
          maxCompletionMs,
          meanDeletionDurationMs: Math.round(meanDeletionDurationMs),
          deletionDurationStandardDeviationMs: Math.round(
            deletionDurationStandardDeviationMs,
          ),
          deletionDurationTwoStandardDeviationsMs: Math.round(
            meanDeletionDurationMs + 2 * deletionDurationStandardDeviationMs,
          ),
          completedTraceCount: finishedTraces.length,
          failedTraceCount: failedTraces.length,
          completedMetricCount: completedMetrics.length,
          failedMetricCount: failedMetrics.length,
          outstandingDeletionCount: report.summary.outstanding,
        }),
      );

      expect(completedAtByWorkspace.size).toBe(EXPECTED_DELETION_COUNT);
      expect(maxCompletionMs).toBeLessThan(10 * 60_000);
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
      if (RUN_THROUGH_CRON) {
        await cronQueue.removeCron({
          jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
        });
      }
      traceSpy.mockRestore();
      metricSpy.mockRestore();
    }
  });
});
