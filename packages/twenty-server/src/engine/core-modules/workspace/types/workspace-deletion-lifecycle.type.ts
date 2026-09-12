import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

export enum WorkspaceDeletionKind {
  E2E = 'E2E',
  INACTIVE = 'INACTIVE',
  MANUAL = 'MANUAL',
}

export enum WorkspaceDeletionPhase {
  MEMBERS = 'MEMBERS',
  METADATA = 'METADATA',
  SCHEMA = 'SCHEMA',
  CACHE = 'CACHE',
  EXTERNAL_CLEANUP = 'EXTERNAL_CLEANUP',
  CORE_ROW = 'CORE_ROW',
}

export const WORKSPACE_DELETION_PHASES = [
  WorkspaceDeletionPhase.MEMBERS,
  WorkspaceDeletionPhase.METADATA,
  WorkspaceDeletionPhase.SCHEMA,
  WorkspaceDeletionPhase.CACHE,
  WorkspaceDeletionPhase.EXTERNAL_CLEANUP,
  WorkspaceDeletionPhase.CORE_ROW,
] as const;

export type WorkspaceDeletionLifecycle = {
  workspaceId: string;
  activationStatus: WorkspaceActivationStatus;
  deletionKind: WorkspaceDeletionKind | null;
  deletionPhase: WorkspaceDeletionPhase | null;
  deletionRequestedAt: Date | null;
  deletionLastProgressAt: Date | null;
  deletionAttemptCount: number;
  deletionLastErrorCode: string | null;
  deletionLastErrorMessage: string | null;
};
