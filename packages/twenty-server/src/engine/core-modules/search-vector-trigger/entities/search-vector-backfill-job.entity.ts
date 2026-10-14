import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';

import { ObjectMetadataEntity } from 'src/engine/metadata-modules/object-metadata/object-metadata.entity';
import { WorkspaceRelatedEntity } from 'src/engine/workspace-manager/types/workspace-related-entity';

export type SearchVectorBackfillJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRYABLE'
  | 'COMPLETED'
  | 'FAILED';

// ARCHIVE and RESTORE also cover search being switched off or on for a field.
export type SearchVectorBackfillJobReason =
  | 'DEFAULT_VALUE'
  | 'OPTION_CHANGE'
  | 'ARCHIVE'
  | 'RESTORE'
  | 'FIELD_DELETE'
  | 'FORMULA_CHANGE'
  | 'REPAIR';

// Null filter means the whole table. Column names are resolved from the field at run time.
export type SearchVectorBackfillJobFilter = {
  fieldMetadataId: string;
  optionValues?: string[];
};

const ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES: SearchVectorBackfillJobStatus[] =
  ['PENDING', 'RUNNING', 'RETRYABLE'];

// The 2-32 instance command repeats this list in its index; keep the two in step.
export const ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL =
  ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES.map(
    (status) => `'${status}'`,
  ).join(', ');

@Entity({ name: 'searchVectorBackfillJob', schema: 'core' })
// One active job per table: a new change resets it instead of adding a second one.
@Index(
  'IDX_SEARCH_VECTOR_BACKFILL_JOB_ACTIVE_OBJECT_UNIQUE',
  ['workspaceId', 'objectMetadataId'],
  {
    unique: true,
    where: `"status" IN (${ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL})`,
  },
)
@Index('IDX_SEARCH_VECTOR_BACKFILL_JOB_STATUS_COMPLETED_AT', [
  'status',
  'completedAt',
])
export class SearchVectorBackfillJobEntity extends WorkspaceRelatedEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: false, type: 'uuid' })
  objectMetadataId: string;

  @ManyToOne(() => ObjectMetadataEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'objectMetadataId' })
  objectMetadata: Relation<ObjectMetadataEntity>;

  @Column({ nullable: false, type: 'text' })
  reason: SearchVectorBackfillJobReason;

  @Column({ nullable: true, type: 'jsonb' })
  filter: SearchVectorBackfillJobFilter | null;

  @Column({ nullable: false, type: 'timestamptz' })
  cutoffAt: Date;

  @Column({ nullable: true, type: 'uuid' })
  cursor: string | null;

  @Column({ nullable: false, type: 'text', default: 'PENDING' })
  status: SearchVectorBackfillJobStatus;

  // Bumped by every claim and reset, so a batch started under an older one cannot move the cursor.
  @Column({ nullable: false, type: 'integer', default: 0 })
  generation: number;

  @Column({ nullable: true, type: 'timestamptz' })
  leaseExpiresAt: Date | null;

  @Column({ nullable: false, type: 'integer', default: 0 })
  attempts: number;

  @Column({ nullable: true, type: 'text' })
  lastError: string | null;

  @Column({ nullable: false, type: 'integer', default: 0 })
  processedRowCount: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ nullable: true, type: 'timestamptz' })
  completedAt: Date | null;
}
