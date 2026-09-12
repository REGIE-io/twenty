import crypto from 'crypto';

import { DataSource } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import {
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';

jest.useRealTimers();

describe('workspace deletion lifecycle PostgreSQL contracts', () => {
  let firstDataSource: DataSource;
  let secondDataSource: DataSource;
  let firstStore: WorkspaceDeletionLifecycleStore;
  let secondStore: WorkspaceDeletionLifecycleStore;
  let workspaceId: string;

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
        workspaceId,
        `deletion-test-${workspaceId}`,
        `workspace_${workspaceId.replace(/-/g, '')}`,
        new Date('2026-09-01T00:00:00.000Z'),
      ],
    );
  });

  afterEach(async () => {
    if (!firstDataSource.isInitialized) {
      return;
    }

    await firstDataSource.query(
      'DELETE FROM "core"."workspace" WHERE id = $1',
      [workspaceId],
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
});
