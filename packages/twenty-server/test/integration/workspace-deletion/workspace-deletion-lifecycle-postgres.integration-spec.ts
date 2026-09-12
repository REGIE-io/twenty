import crypto from 'crypto';

import { DataSource } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { WorkspaceDeletionMonitoringService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-monitoring.service';

jest.useRealTimers();

describe('workspace deletion lifecycle PostgreSQL contracts', () => {
  let firstDataSource: DataSource;
  let secondDataSource: DataSource;
  let firstStore: WorkspaceDeletionLifecycleStore;
  let secondStore: WorkspaceDeletionLifecycleStore;
  let workspaceId: string;
  let workspaceIds: string[];

  const insertWorkspace = async (id: string) => {
    workspaceIds.push(id);
    await firstDataSource.query(
      `INSERT INTO "core"."workspace" (
        id,
        subdomain,
        "activationStatus",
        "workspaceCustomApplicationId",
        "defaultRoleId",
        "databaseSchema",
        "deletedAt"
      )
      SELECT $1, $2, 'SUSPENDED', application.id, role.id, $3, $4
      FROM "core"."application" application
      CROSS JOIN "core"."role" role
      LIMIT 1`,
      [
        id,
        `deletion-test-${id}`,
        `workspace_${id.replace(/-/g, '')}`,
        new Date('2026-09-01T00:00:00.000Z'),
      ],
    );
  };

  const requestAndClaim = async ({
    requestedAt = new Date('2026-09-02T00:00:00.000Z'),
    claimedAt = new Date('2026-09-02T00:01:00.000Z'),
  } = {}) => {
    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      requestedAt,
    );

    return firstStore.claimDeletion(workspaceId, claimedAt, 30_000);
  };

  const readLifecycleRow = async () => {
    const [row] = await firstDataSource.query(
      `SELECT
        "activationStatus",
        "deletionPhase",
        "deletionLastProgressAt",
        "deletionAttemptCount",
        "deletionLastErrorCode",
        "deletionLastErrorMessage"
      FROM "core"."workspace"
      WHERE id = $1`,
      [workspaceId],
    );

    return row;
  };

  beforeAll(async () => {
    const ssl =
      process.env.PG_DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : false;

    firstDataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
      ssl,
    });
    secondDataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
      ssl,
    });
    await Promise.all([
      firstDataSource.initialize(),
      secondDataSource.initialize(),
    ]);

    const queryRunner = firstDataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await new AddWorkspaceDeletionLifecycleFastInstanceCommand().up(
        queryRunner,
      );
    } finally {
      await queryRunner.release();
    }

    firstStore = new WorkspaceDeletionLifecycleStore(firstDataSource);
    secondStore = new WorkspaceDeletionLifecycleStore(secondDataSource);
  });

  beforeEach(async () => {
    workspaceId = crypto.randomUUID();
    workspaceIds = [];
    await insertWorkspace(workspaceId);
  });

  afterEach(async () => {
    if (!firstDataSource.isInitialized) {
      return;
    }

    await firstDataSource.query(
      'DELETE FROM "core"."workspace" WHERE id = ANY($1::uuid[])',
      [workspaceIds],
    );
  });

  afterAll(async () => {
    await Promise.all(
      [firstDataSource, secondDataSource]
        .filter((dataSource) => dataSource.isInitialized)
        .map((dataSource) => dataSource.destroy()),
    );
  });

  it('persists a requested deletion on the workspace row', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');

    await expect(
      firstStore.requestDeletion(workspaceId, WorkspaceDeletionKind.E2E, now),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionKind: WorkspaceDeletionKind.E2E,
      deletionPhase: WorkspaceDeletionPhase.MEMBERS,
      deletionRequestedAt: now,
      deletionLastProgressAt: now,
      deletionAttemptCount: 0,
    });
  });

  it('allows exactly one of two database connections to claim a pending deletion', async () => {
    const requestedAt = new Date('2026-09-02T00:00:00.000Z');
    const claimedAt = new Date('2026-09-02T00:01:00.000Z');

    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      requestedAt,
    );

    const claims = await Promise.all([
      firstStore.claimDeletion(workspaceId, claimedAt, 30_000),
      secondStore.claimDeletion(workspaceId, claimedAt, 30_000),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(claims.find((claim) => claim !== null)).toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.MEMBERS,
      deletionAttemptCount: 1,
    });
  });

  it('serializes one workspace with an advisory lock while allowing another workspace', async () => {
    const firstLock = new PostgresAdvisoryLockService(firstDataSource);
    const secondLock = new PostgresAdvisoryLockService(secondDataSource);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));

    const firstExecution = firstLock.tryWithLock(
      `workspace-deletion:${workspaceId}`,
      async () => {
        entered();
        await held;
        return 'first';
      },
    );
    await firstEntered;

    await expect(
      secondLock.tryWithLock(
        `workspace-deletion:${workspaceId}`,
        async () => 'duplicate',
      ),
    ).resolves.toEqual({ acquired: false });
    await expect(
      secondLock.tryWithLock(
        `workspace-deletion:${crypto.randomUUID()}`,
        async () => 'independent',
      ),
    ).resolves.toEqual({ acquired: true, value: 'independent' });

    release();
    await expect(firstExecution).resolves.toEqual({
      acquired: true,
      value: 'first',
    });
  });

  it('protects a fresh claim and reclaims it at the stale boundary', async () => {
    const requestedAt = new Date('2026-09-02T00:00:00.000Z');
    const claimedAt = new Date('2026-09-02T00:01:00.000Z');

    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      requestedAt,
    );
    await firstStore.claimDeletion(workspaceId, claimedAt, 30_000);

    await expect(
      secondStore.claimDeletion(
        workspaceId,
        new Date(claimedAt.getTime() + 29_999),
        30_000,
      ),
    ).resolves.toBeNull();
    await expect(
      secondStore.claimDeletion(
        workspaceId,
        new Date(claimedAt.getTime() + 30_000),
        30_000,
      ),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.MEMBERS,
      deletionAttemptCount: 2,
    });
  });

  it('persists only the next phase and rejects a replayed checkpoint', async () => {
    const checkpointedAt = new Date('2026-09-02T00:02:00.000Z');

    await requestAndClaim();

    await expect(
      firstStore.checkpointPhase(
        workspaceId,
        WorkspaceDeletionPhase.MEMBERS,
        1,
        checkpointedAt,
      ),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.METADATA,
      deletionLastProgressAt: checkpointedAt,
      deletionAttemptCount: 1,
    });
    await expect(
      firstStore.checkpointPhase(
        workspaceId,
        WorkspaceDeletionPhase.MEMBERS,
        1,
        new Date('2026-09-02T00:03:00.000Z'),
      ),
    ).resolves.toBeNull();
    await expect(readLifecycleRow()).resolves.toMatchObject({
      deletionPhase: WorkspaceDeletionPhase.METADATA,
      deletionLastProgressAt: checkpointedAt,
    });
  });

  it('persists terminal failure without losing the failed phase', async () => {
    await requestAndClaim();
    await firstDataSource.query(
      `UPDATE "core"."workspace" SET "deletionPhase" = $2 WHERE id = $1`,
      [workspaceId, WorkspaceDeletionPhase.SCHEMA],
    );

    await expect(
      firstStore.recordFailure(
        workspaceId,
        WorkspaceDeletionPhase.SCHEMA,
        1,
        'QUERY_TIMEOUT',
        'injected schema timeout',
        1,
      ),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.DELETION_FAILED,
      deletionPhase: WorkspaceDeletionPhase.SCHEMA,
      deletionAttemptCount: 1,
      deletionLastErrorCode: 'QUERY_TIMEOUT',
      deletionLastErrorMessage: 'injected schema timeout',
    });
  });

  it('retries terminal failure at the same persisted phase', async () => {
    const retriedAt = new Date('2026-09-02T01:00:00.000Z');

    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      new Date('2026-09-02T00:00:00.000Z'),
    );
    await firstDataSource.query(
      `UPDATE "core"."workspace"
          SET "activationStatus" = $2,
              "deletionPhase" = $3,
              "deletionAttemptCount" = 3,
              "deletionLastErrorCode" = 'DNS_TIMEOUT',
              "deletionLastErrorMessage" = 'injected DNS timeout'
        WHERE id = $1`,
      [
        workspaceId,
        WorkspaceActivationStatus.DELETION_FAILED,
        WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
      ],
    );

    await expect(
      firstStore.retryFailedDeletion(workspaceId, retriedAt),
    ).resolves.toMatchObject({
      workspaceId,
      activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
      deletionLastProgressAt: retriedAt,
      deletionAttemptCount: 3,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    });
  });

  it('fences a stale worker from checkpointing or recording failure after reclamation', async () => {
    const firstClaimedAt = new Date('2026-09-02T00:01:00.000Z');
    const reclaimedAt = new Date('2026-09-02T00:01:30.000Z');

    await requestAndClaim({ claimedAt: firstClaimedAt });
    await secondStore.claimDeletion(workspaceId, reclaimedAt, 30_000);

    await expect(
      firstStore.checkpointPhase(
        workspaceId,
        WorkspaceDeletionPhase.MEMBERS,
        1,
        new Date('2026-09-02T00:01:31.000Z'),
      ),
    ).resolves.toBeNull();
    await expect(
      firstStore.recordFailure(
        workspaceId,
        WorkspaceDeletionPhase.MEMBERS,
        1,
        'STALE_WORKER_ERROR',
        'the old worker must not win',
        3,
      ),
    ).resolves.toBeNull();
    await expect(readLifecycleRow()).resolves.toMatchObject({
      activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
      deletionPhase: WorkspaceDeletionPhase.MEMBERS,
      deletionAttemptCount: 2,
      deletionLastErrorCode: null,
      deletionLastErrorMessage: null,
    });

    await expect(
      secondStore.checkpointPhase(
        workspaceId,
        WorkspaceDeletionPhase.MEMBERS,
        2,
        new Date('2026-09-02T00:01:32.000Z'),
      ),
    ).resolves.toMatchObject({
      deletionPhase: WorkspaceDeletionPhase.METADATA,
      deletionAttemptCount: 2,
    });
  });

  it('discovers pending work immediately but ongoing work only after it becomes stale', async () => {
    const requestedAt = new Date('2026-09-02T00:00:00.000Z');
    const claimedAt = new Date('2026-09-02T00:01:00.000Z');

    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      requestedAt,
    );
    await expect(
      firstStore.findRecoveryCandidates(requestedAt, 30_000, 15),
    ).resolves.toEqual([
      expect.objectContaining({
        workspaceId,
        activationStatus: WorkspaceActivationStatus.PENDING_DELETION,
      }),
    ]);

    await firstStore.claimDeletion(workspaceId, claimedAt, 30_000);
    await expect(
      firstStore.findRecoveryCandidates(
        new Date(claimedAt.getTime() + 29_999),
        30_000,
        15,
      ),
    ).resolves.toEqual([]);
    await expect(
      firstStore.findRecoveryCandidates(
        new Date(claimedAt.getTime() + 30_000),
        30_000,
        15,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        workspaceId,
        activationStatus: WorkspaceActivationStatus.ONGOING_DELETION,
        deletionAttemptCount: 1,
      }),
    ]);
  });

  it('considers deletion complete only when the core workspace row is absent', async () => {
    await expect(firstStore.isDeletionComplete(workspaceId)).resolves.toBe(
      false,
    );
    await requestAndClaim();
    await firstDataSource.query(
      `UPDATE "core"."workspace" SET "deletionPhase" = $2 WHERE id = $1`,
      [workspaceId, WorkspaceDeletionPhase.CORE_ROW],
    );
    await expect(firstStore.isDeletionComplete(workspaceId)).resolves.toBe(
      false,
    );

    await firstDataSource.query(
      'DELETE FROM "core"."workspace" WHERE id = $1',
      [workspaceId],
    );
    await expect(firstStore.isDeletionComplete(workspaceId)).resolves.toBe(
      true,
    );
  });

  it('produces the expected PostgreSQL-backed monitoring rows', async () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const stalledId = crypto.randomUUID();
    const retryableId = crypto.randomUUID();
    const failedId = crypto.randomUUID();

    await Promise.all([
      insertWorkspace(stalledId),
      insertWorkspace(retryableId),
      insertWorkspace(failedId),
    ]);
    await firstStore.requestDeletion(
      workspaceId,
      WorkspaceDeletionKind.E2E,
      new Date('2026-09-12T11:55:00.000Z'),
    );
    await firstStore.requestDeletion(
      stalledId,
      WorkspaceDeletionKind.E2E,
      new Date('2026-09-12T11:40:00.000Z'),
    );
    await firstStore.claimDeletion(
      stalledId,
      new Date('2026-09-12T11:58:00.000Z'),
      120_000,
    );
    await firstStore.requestDeletion(
      retryableId,
      WorkspaceDeletionKind.E2E,
      new Date('2026-09-12T11:45:00.000Z'),
    );
    await firstStore.claimDeletion(
      retryableId,
      new Date('2026-09-12T11:59:00.000Z'),
      120_000,
    );
    await firstStore.recordFailure(
      retryableId,
      WorkspaceDeletionPhase.MEMBERS,
      1,
      'REDIS_TIMEOUT',
      'cache unavailable',
      3,
    );
    await firstStore.requestDeletion(
      failedId,
      WorkspaceDeletionKind.E2E,
      new Date('2026-09-12T11:30:00.000Z'),
    );
    await firstStore.claimDeletion(
      failedId,
      new Date('2026-09-12T11:50:00.000Z'),
      120_000,
    );
    await firstStore.recordFailure(
      failedId,
      WorkspaceDeletionPhase.MEMBERS,
      1,
      'DNS_TIMEOUT',
      'DNS provider unavailable',
      1,
    );

    const report = await new WorkspaceDeletionMonitoringService(
      firstStore,
    ).report(now, 120_000);
    const rows = report.rows.filter((row) =>
      workspaceIds.includes(row.workspaceId),
    );

    expect(
      rows.map(({ workspaceId: id, state, ageMs, idleMs }) => ({
        workspaceId: id,
        state,
        ageMs,
        idleMs,
      })),
    ).toEqual([
      {
        workspaceId: failedId,
        state: 'terminal-failure',
        ageMs: 1_800_000,
        idleMs: 600_000,
      },
      {
        workspaceId: stalledId,
        state: 'stalled',
        ageMs: 1_200_000,
        idleMs: 120_000,
      },
      {
        workspaceId: retryableId,
        state: 'retryable-failure',
        ageMs: 900_000,
        idleMs: 60_000,
      },
      { workspaceId, state: 'pending', ageMs: 300_000, idleMs: 300_000 },
    ]);
  });
});
