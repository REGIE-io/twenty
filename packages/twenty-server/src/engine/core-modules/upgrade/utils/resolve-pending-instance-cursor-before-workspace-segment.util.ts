type UpgradeStepKind = 'fast-instance' | 'slow-instance' | 'workspace';

export const resolvePendingInstanceCursorBeforeWorkspaceSegment = ({
  sequenceKinds,
  lastAttemptedInstanceCursor,
  lastAttemptedInstanceStatus,
  workspaceSegmentStartCursor,
}: {
  sequenceKinds: UpgradeStepKind[];
  lastAttemptedInstanceCursor: number;
  lastAttemptedInstanceStatus: 'completed' | 'failed';
  workspaceSegmentStartCursor: number;
}): number | null => {
  const instanceResumeCursor =
    lastAttemptedInstanceStatus === 'completed'
      ? lastAttemptedInstanceCursor + 1
      : lastAttemptedInstanceCursor;

  if (instanceResumeCursor >= workspaceSegmentStartCursor) {
    return null;
  }

  const hasWorkspaceStepBeforeCurrentSegment = sequenceKinds
    .slice(instanceResumeCursor, workspaceSegmentStartCursor)
    .includes('workspace');

  return hasWorkspaceStepBeforeCurrentSegment ? null : instanceResumeCursor;
};
