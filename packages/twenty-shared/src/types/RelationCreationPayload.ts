import { type RelationOnDeleteAction } from '@/types/RelationOnDeleteAction.type';
import { type RelationType } from '@/types/RelationType';

export type RelationCreationPayload = {
  type: RelationType;
  targetObjectMetadataId: string;
  targetFieldLabel: string;
  targetFieldIcon: string;
  // Preserve a stable API name when a human-readable label would be normalized
  // differently (for example camelCase labels).
  targetFieldName?: string;
  // Defaults to SET_NULL for backwards compatibility. Provisioners that own
  // dependent records can explicitly require a database cascade.
  onDelete?: RelationOnDeleteAction;
};
