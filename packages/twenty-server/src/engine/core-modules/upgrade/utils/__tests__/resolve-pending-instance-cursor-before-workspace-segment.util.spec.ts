import { resolvePendingInstanceCursorBeforeWorkspaceSegment } from 'src/engine/core-modules/upgrade/utils/resolve-pending-instance-cursor-before-workspace-segment.util';

describe('resolvePendingInstanceCursorBeforeWorkspaceSegment', () => {
  it('rewinds to a newly pending instance command before a failed workspace segment', () => {
    expect(
      resolvePendingInstanceCursorBeforeWorkspaceSegment({
        sequenceKinds: ['fast-instance', 'fast-instance', 'workspace'],
        lastAttemptedInstanceCursor: 0,
        lastAttemptedInstanceStatus: 'completed',
        workspaceSegmentStartCursor: 2,
      }),
    ).toBe(1);
  });

  it('does not rewind across an earlier workspace segment', () => {
    expect(
      resolvePendingInstanceCursorBeforeWorkspaceSegment({
        sequenceKinds: [
          'fast-instance',
          'workspace',
          'fast-instance',
          'workspace',
        ],
        lastAttemptedInstanceCursor: 0,
        lastAttemptedInstanceStatus: 'completed',
        workspaceSegmentStartCursor: 3,
      }),
    ).toBeNull();
  });
});
