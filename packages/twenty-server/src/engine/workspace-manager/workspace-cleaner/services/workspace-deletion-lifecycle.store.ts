import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type DataSource } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  type WorkspaceDeletionLifecycle,
  WORKSPACE_DELETION_PHASES,
  WorkspaceDeletionKind,
  WorkspaceDeletionPhase,
} from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';

type WorkspaceDeletionLifecycleRow = Omit<
  WorkspaceDeletionLifecycle,
  'deletionAttemptCount'
> & {
  deletionAttemptCount: number | string;
};

type WorkspaceDeletionQueryResult =
  | WorkspaceDeletionLifecycleRow[]
  | [WorkspaceDeletionLifecycleRow[], number];

const WORKSPACE_DELETION_RETURNING = `
  id AS "workspaceId",
  "activationStatus",
  "deletionKind",
  "deletionPhase",
  "deletionRequestedAt",
  "deletionLastProgressAt",
  "deletionAttemptCount",
  "deletionLastErrorCode",
  "deletionLastErrorMessage"
`;

@Injectable()
export class WorkspaceDeletionLifecycleStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async requestDeletion(
    workspaceId: string,
    kind: WorkspaceDeletionKind,
    now: Date,
  ): Promise<WorkspaceDeletionLifecycle | null> {
    const result = await this.dataSource.query<WorkspaceDeletionQueryResult>(
      `UPDATE "core"."workspace"
          SET "activationStatus" = $2,
              "deletionKind" = $3,
              "deletionPhase" = $4,
              "deletionRequestedAt" = $5,
              "deletionLastProgressAt" = $5,
              "deletionAttemptCount" = 0,
              "deletionLastErrorCode" = NULL,
              "deletionLastErrorMessage" = NULL
        WHERE id = $1
          AND "activationStatus" = $6
      RETURNING ${WORKSPACE_DELETION_RETURNING}`,
      [
        workspaceId,
        WorkspaceActivationStatus.PENDING_DELETION,
        kind,
        WorkspaceDeletionPhase.MEMBERS,
        now,
        WorkspaceActivationStatus.SUSPENDED,
      ],
    );

    return this.mapFirstRow(result);
  }

  async claimDeletion(
    workspaceId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<WorkspaceDeletionLifecycle | null> {
    const staleBefore = new Date(now.getTime() - staleAfterMs);
    const result = await this.dataSource.query<WorkspaceDeletionQueryResult>(
      `UPDATE "core"."workspace"
          SET "activationStatus" = $2,
              "deletionLastProgressAt" = $3,
              "deletionAttemptCount" = "deletionAttemptCount" + 1
        WHERE id = $1
          AND (
            "activationStatus" = $4
            OR (
              "activationStatus" = $2
              AND "deletionLastProgressAt" <= $5
            )
          )
      RETURNING ${WORKSPACE_DELETION_RETURNING}`,
      [
        workspaceId,
        WorkspaceActivationStatus.ONGOING_DELETION,
        now,
        WorkspaceActivationStatus.PENDING_DELETION,
        staleBefore,
      ],
    );

    return this.mapFirstRow(result);
  }

  async checkpointPhase(
    workspaceId: string,
    completedPhase: WorkspaceDeletionPhase,
    expectedAttempt: number,
    now: Date,
  ): Promise<WorkspaceDeletionLifecycle | null> {
    const phaseIndex = WORKSPACE_DELETION_PHASES.indexOf(completedPhase);
    const nextPhase = WORKSPACE_DELETION_PHASES[phaseIndex + 1];

    if (nextPhase === undefined) {
      throw new Error('CORE_ROW completion is represented by an absent row');
    }

    const result = await this.dataSource.query<WorkspaceDeletionQueryResult>(
      `UPDATE "core"."workspace"
          SET "deletionPhase" = $5,
              "deletionLastProgressAt" = $4,
              "deletionLastErrorCode" = NULL,
              "deletionLastErrorMessage" = NULL
        WHERE id = $1
          AND "activationStatus" = $2
          AND "deletionPhase" = $3
          AND "deletionAttemptCount" = $6
      RETURNING ${WORKSPACE_DELETION_RETURNING}`,
      [
        workspaceId,
        WorkspaceActivationStatus.ONGOING_DELETION,
        completedPhase,
        now,
        nextPhase,
        expectedAttempt,
      ],
    );

    return this.mapFirstRow(result);
  }

  async recordFailure(
    workspaceId: string,
    failedPhase: WorkspaceDeletionPhase,
    expectedAttempt: number,
    errorCode: string,
    errorMessage: string,
    maxAttempts: number,
  ): Promise<WorkspaceDeletionLifecycle | null> {
    const result = await this.dataSource.query<WorkspaceDeletionQueryResult>(
      `UPDATE "core"."workspace"
          SET "activationStatus" = CASE
                WHEN "deletionAttemptCount" >= $6 THEN $7
                ELSE "activationStatus"
              END,
              "deletionLastErrorCode" = $4,
              "deletionLastErrorMessage" = $5
        WHERE id = $1
          AND "activationStatus" = $2
          AND "deletionPhase" = $3
          AND "deletionAttemptCount" = $8
      RETURNING ${WORKSPACE_DELETION_RETURNING}`,
      [
        workspaceId,
        WorkspaceActivationStatus.ONGOING_DELETION,
        failedPhase,
        errorCode.slice(0, 100),
        errorMessage.slice(0, 1000),
        maxAttempts,
        WorkspaceActivationStatus.DELETION_FAILED,
        expectedAttempt,
      ],
    );

    return this.mapFirstRow(result);
  }

  async retryFailedDeletion(
    workspaceId: string,
    now: Date,
  ): Promise<WorkspaceDeletionLifecycle | null> {
    const result = await this.dataSource.query<WorkspaceDeletionQueryResult>(
      `UPDATE "core"."workspace"
          SET "activationStatus" = $2,
              "deletionLastProgressAt" = $3,
              "deletionLastErrorCode" = NULL,
              "deletionLastErrorMessage" = NULL
        WHERE id = $1
          AND "activationStatus" = $4
      RETURNING ${WORKSPACE_DELETION_RETURNING}`,
      [
        workspaceId,
        WorkspaceActivationStatus.PENDING_DELETION,
        now,
        WorkspaceActivationStatus.DELETION_FAILED,
      ],
    );

    return this.mapFirstRow(result);
  }

  async findRecoveryCandidates(
    now: Date,
    staleAfterMs: number,
    limit: number,
  ): Promise<WorkspaceDeletionLifecycle[]> {
    const rows = await this.dataSource.query<WorkspaceDeletionLifecycleRow[]>(
      `SELECT ${WORKSPACE_DELETION_RETURNING}
         FROM "core"."workspace"
        WHERE "activationStatus" = $1
           OR (
             "activationStatus" = $2
             AND "deletionLastProgressAt" <= $3
           )
        ORDER BY "deletionLastProgressAt" ASC, id ASC
        LIMIT $4`,
      [
        WorkspaceActivationStatus.PENDING_DELETION,
        WorkspaceActivationStatus.ONGOING_DELETION,
        new Date(now.getTime() - staleAfterMs),
        limit,
      ],
    );

    return rows.map((row) => this.mapRow(row));
  }

  async isDeletionComplete(workspaceId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM "core"."workspace" WHERE id = $1
       ) AS "exists"`,
      [workspaceId],
    );

    return rows[0]?.exists === false;
  }

  async findOutstandingDeletions(): Promise<WorkspaceDeletionLifecycle[]> {
    const rows = await this.dataSource.query<WorkspaceDeletionLifecycleRow[]>(
      `SELECT ${WORKSPACE_DELETION_RETURNING}
         FROM "core"."workspace"
        WHERE "activationStatus" IN ($1, $2, $3)
        ORDER BY "deletionRequestedAt" ASC, id ASC`,
      [
        WorkspaceActivationStatus.PENDING_DELETION,
        WorkspaceActivationStatus.ONGOING_DELETION,
        WorkspaceActivationStatus.DELETION_FAILED,
      ],
    );

    return rows.map((row) => this.mapRow(row));
  }

  private mapFirstRow(
    result: WorkspaceDeletionQueryResult,
  ): WorkspaceDeletionLifecycle | null {
    const firstResult = result[0];
    const row = Array.isArray(firstResult) ? firstResult[0] : firstResult;

    if (row === undefined) {
      return null;
    }

    return this.mapRow(row);
  }

  private mapRow(
    row: WorkspaceDeletionLifecycleRow,
  ): WorkspaceDeletionLifecycle {
    return { ...row, deletionAttemptCount: Number(row.deletionAttemptCount) };
  }
}
