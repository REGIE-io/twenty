import { type RegieSource } from '@/constants/RegieSource';
import { type ObjectRecordDiff } from '@/database-events/object-record-diff';

type Properties<T> = {
  updatedFields?: string[];
  before?: T;
  after?: T;
  diff?: Partial<ObjectRecordDiff<T>>;
};

export class ObjectRecordBaseEvent<T = object> {
  recordId: string;
  userId?: string;
  userWorkspaceId?: string;
  workspaceMemberId?: string;
  // Which Regie write path produced this change, when it came from Regie. Absent for
  // edits made directly in Twenty and for any write that did not carry the header.
  source?: RegieSource;
  properties: Properties<T>;
}
