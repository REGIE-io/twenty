import { type RegieSource } from 'twenty-shared/constants';
import { type ObjectRecordBaseEvent } from 'twenty-shared/database-events';

export type TimelineActivityPayload = {
  properties: ObjectRecordBaseEvent['properties'];
  linkedObjectMetadataId?: string;
  linkedRecordId?: string;
  linkedRecordCachedName?: string;
  workspaceMemberId?: string;
  // Which Regie write path produced the change, carried from the event to the row.
  source?: RegieSource;
  name: string;
  recordId: string;
  objectSingularName?: string;
};
