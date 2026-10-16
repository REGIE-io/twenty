import { type RegieSource } from 'twenty-shared/constants';
import { type ObjectRecordBaseEvent } from 'twenty-shared/database-events';
import { type TimelineActivityTypeSnapshot } from 'twenty-shared/timeline';

export type TimelineActivityPayload = {
  happensAt: Date;
  properties: ObjectRecordBaseEvent['properties'];
  linkedObjectMetadataId?: string;
  linkedRecordId?: string;
  linkedRecordCachedName?: string;
  workspaceMemberId?: string;
  // Which Regie write path produced the change, carried from the event to the row.
  source?: RegieSource;
  timelineActivityTypeId: string;
  timelineActivityTypeSnapshot: TimelineActivityTypeSnapshot;
  recordId: string;
  objectSingularName?: string;
};
