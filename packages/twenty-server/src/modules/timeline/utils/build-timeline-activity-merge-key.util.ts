import { type RegieSource } from 'twenty-shared/constants';
import { type TimelineActivityTypeSnapshot } from 'twenty-shared/timeline';

type TimelineActivityMergeKeyArgs = {
  recordId: string;
  source?: RegieSource | null;
  workspaceMemberId: string | null | undefined;
  timelineActivityTypeId: string;
  timelineActivityTypeSnapshot: TimelineActivityTypeSnapshot | null;
};

export const buildTimelineActivityMergeKey = ({
  recordId,
  source,
  workspaceMemberId,
  timelineActivityTypeId,
  timelineActivityTypeSnapshot,
}: TimelineActivityMergeKeyArgs): string =>
  JSON.stringify([
    recordId,
    source || null,
    workspaceMemberId ?? null,
    timelineActivityTypeId,
    timelineActivityTypeSnapshot?.universalIdentifier,
    timelineActivityTypeSnapshot?.action,
    timelineActivityTypeSnapshot?.objectUniversalIdentifier,
  ]);

export const buildTimelineActivityMergeKeyCandidates = (
  args: TimelineActivityMergeKeyArgs,
): string[] => {
  const exactKey = buildTimelineActivityMergeKey(args);

  if (args.timelineActivityTypeSnapshot === null) {
    return [exactKey];
  }

  return [
    exactKey,
    buildTimelineActivityMergeKey({
      ...args,
      timelineActivityTypeSnapshot: null,
    }),
  ];
};
