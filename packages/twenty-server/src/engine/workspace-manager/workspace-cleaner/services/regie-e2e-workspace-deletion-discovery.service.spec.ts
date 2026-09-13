import { type Repository } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { type KeyValuePairEntity } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { type MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import {
  type WorkspaceDeletionLifecycle,
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import {
  RegieE2eWorkspaceDeletionDiscoveryService,
  type WorkspaceDeletionEnqueuer,
} from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-deletion-discovery.service';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { type WorkspaceDeletionTraceService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

describe('RegieE2eWorkspaceDeletionDiscoveryService', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');
  const gracePeriodMs = 24 * 60 * 60 * 1000;
  const staleAfterMs = 30_000;
  const limit = 15;
  const workspace = {
    id: '20202020-0000-4000-8000-000000000001',
    subdomain: 'org-e2e-run-1',
  };
  const markerRow = {
    workspace,
    value: {
      ephemeral: true,
      organizationId: 'org_e2e_run_1',
      workspaceSlug: workspace.subdomain,
    },
  };
  const lifecycle = (workspaceId: string): WorkspaceDeletionLifecycle => ({
    workspaceId,
    activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
    deletionKind: WorkspaceDeletionKind.E2E,
    deletionPhase: WorkspaceDeletionPhase.MEMBERS,
    deletionRequestedAt: now,
    deletionLastProgressAt: now,
    deletionAttemptCount: 0,
    deletionLastErrorCode: null,
    deletionLastErrorMessage: null,
  });

  const makeService = ({
    markerRows = [markerRow],
    recovery = [],
    requested = lifecycle(workspace.id),
  }: {
    markerRows?: unknown[];
    recovery?: WorkspaceDeletionLifecycle[];
    requested?: WorkspaceDeletionLifecycle | null;
  } = {}) => {
    const queryBuilder: Record<string, jest.Mock> = {};

    for (const method of [
      'withDeleted',
      'innerJoinAndSelect',
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'limit',
    ]) {
      queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
    }
    queryBuilder.getMany = jest.fn().mockResolvedValue(markerRows);

    const markerRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const lifecycleStore = {
      findRecoveryCandidates: jest.fn().mockResolvedValue(recovery),
      requestDeletion: jest.fn().mockResolvedValue(requested),
    };
    const enqueuer = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const trace = { record: jest.fn() };
    const metrics = {
      incrementCounterBy: jest.fn(),
      incrementCounterForEvent: jest.fn(),
    };
    const service = Reflect.construct(
      RegieE2eWorkspaceDeletionDiscoveryService,
      [
        markerRepository as unknown as Repository<KeyValuePairEntity>,
        lifecycleStore as unknown as WorkspaceDeletionLifecycleStore,
        trace as unknown as WorkspaceDeletionTraceService,
        metrics as unknown as MetricsService,
      ],
    );

    return {
      service,
      queryBuilder,
      lifecycleStore,
      enqueuer,
      trace,
      metrics,
    };
  };

  const discover = (
    service: RegieE2eWorkspaceDeletionDiscoveryService,
    enqueuer: WorkspaceDeletionEnqueuer,
    at = now,
  ) =>
    service.discover(enqueuer, {
      now: at,
      gracePeriodMs,
      staleAfterMs,
      limit,
    });

  it('re-enqueues recovery before admitting fresh work', async () => {
    const stranded = lifecycle('20202020-0000-4000-8000-000000000099');
    const { service, lifecycleStore, enqueuer } = makeService({
      recovery: [stranded],
    });

    await expect(discover(service, enqueuer)).resolves.toEqual({
      recovered: 1,
      admitted: 1,
    });
    expect(enqueuer.enqueue).toHaveBeenNthCalledWith(1, {
      workspaceId: stranded.workspaceId,
      jobId: `workspace-delete-${stranded.workspaceId}`,
    });
    expect(lifecycleStore.requestDeletion).toHaveBeenCalledWith(
      workspace.id,
      WorkspaceDeletionKind.E2E,
      now,
    );
    expect(enqueuer.enqueue).toHaveBeenNthCalledWith(2, {
      workspaceId: workspace.id,
      jobId: `workspace-delete-${workspace.id}`,
    });
  });

  it('emits discovery lifecycle events and bounded-cardinality counters', async () => {
    const stranded = lifecycle('20202020-0000-4000-8000-000000000099');
    const { service, enqueuer, trace, metrics } = makeService({
      recovery: [stranded],
    });

    await discover(service, enqueuer);

    expect(trace.record).toHaveBeenNthCalledWith(1, {
      event: 'workspace_deletion_discovery_started',
      deletionKind: 'E2E',
    });
    expect(trace.record).toHaveBeenLastCalledWith({
      event: 'workspace_deletion_discovery_finished',
      deletionKind: 'E2E',
      candidates: 1,
      recovered: 1,
      admitted: 1,
    });
    expect(metrics.incrementCounterBy).toHaveBeenCalledWith({
      key: 'workspace-deletion/discovery-candidates',
      amount: 1,
      attributes: { deletionKind: 'E2E' },
    });
    expect(metrics.incrementCounterBy).toHaveBeenCalledWith({
      key: 'workspace-deletion/admitted',
      amount: 1,
      attributes: { deletionKind: 'E2E' },
    });
    expect(metrics.incrementCounterBy).toHaveBeenCalledWith({
      key: 'workspace-deletion/recovered',
      amount: 1,
      attributes: { deletionKind: 'E2E' },
    });
    expect(metrics.incrementCounterBy.mock.calls.flat()).not.toContain(
      workspace.id,
    );
    expect(metrics.incrementCounterForEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'workspace-deletion/completed' }),
    );
  });

  it('emits a failed discovery event and counter before propagating the error to the Sentry monitor', async () => {
    const { service, queryBuilder, enqueuer, trace, metrics } = makeService();
    const failure = new Error('marker query timed out');

    queryBuilder.getMany.mockRejectedValue(failure);

    await expect(discover(service, enqueuer)).rejects.toBe(failure);

    expect(trace.record).toHaveBeenNthCalledWith(1, {
      event: 'workspace_deletion_discovery_started',
      deletionKind: 'E2E',
    });
    expect(trace.record).toHaveBeenLastCalledWith({
      event: 'workspace_deletion_discovery_failed',
      deletionKind: 'E2E',
      errorCode: 'ERROR',
      errorMessage: 'marker query timed out',
    });
    expect(metrics.incrementCounterForEvent).toHaveBeenCalledWith({
      key: 'workspace-deletion/discovery-failed',
      attributes: { deletionKind: 'E2E', errorCode: 'ERROR' },
      shouldStoreInCache: false,
    });
  });

  it('recomputes the grace cutoff from deletedAt policy without putting a date on the job', async () => {
    const { service, queryBuilder, enqueuer } = makeService();

    await discover(service, enqueuer);

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'workspace.deletedAt <= :cutoff',
      { cutoff: new Date('2026-09-11T12:00:00.000Z') },
    );
    expect(enqueuer.enqueue).toHaveBeenCalledWith({
      workspaceId: workspace.id,
      jobId: `workspace-delete-${workspace.id}`,
    });
    expect(enqueuer.enqueue.mock.calls[0][0]).not.toHaveProperty('purgeAfter');
    expect(queryBuilder.limit).toHaveBeenCalledWith(15);
  });

  it('refuses a candidate whose persistent identity does not match', async () => {
    const { service, lifecycleStore, enqueuer } = makeService({
      markerRows: [
        {
          ...markerRow,
          value: { ...markerRow.value, workspaceSlug: 'org-e2e-other' },
        },
      ],
    });

    await expect(discover(service, enqueuer)).resolves.toEqual({
      recovered: 0,
      admitted: 0,
    });
    expect(lifecycleStore.requestDeletion).not.toHaveBeenCalled();
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
  });
});
