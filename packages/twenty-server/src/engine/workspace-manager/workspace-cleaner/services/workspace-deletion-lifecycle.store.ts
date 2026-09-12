import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { type DataSource } from 'typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import {
  type WorkspaceDeletionLifecycle,
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

  private mapFirstRow(
    result: WorkspaceDeletionQueryResult,
  ): WorkspaceDeletionLifecycle | null {
    const firstResult = result[0];
    const row = Array.isArray(firstResult) ? firstResult[0] : firstResult;

    if (row === undefined) {
      return null;
    }

    return {
      ...row,
      deletionAttemptCount: Number(row.deletionAttemptCount),
    };
  }
}
