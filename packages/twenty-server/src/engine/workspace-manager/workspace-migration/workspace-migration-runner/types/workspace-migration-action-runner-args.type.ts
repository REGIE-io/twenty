import { type QueryRunner } from 'typeorm';

import { type FlatApplication } from 'src/engine/core-modules/application/types/flat-application.type';
import { type SearchListChange } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { type PreallocatedIdByUniversalIdentifierByMetadataName } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/utils/resolve-universal-relation-identifiers-to-ids.util';
import {
  type AllFlatWorkspaceMigrationAction,
  type AllUniversalWorkspaceMigrationAction,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration-action-common';

export type WorkspaceMigrationActionRunnerArgs<
  TUniversalAction extends AllUniversalWorkspaceMigrationAction,
> = {
  queryRunner: QueryRunner;
  action: TUniversalAction;
  allFlatEntityMaps: AllFlatEntityMaps;
  workspaceId: string;
  flatApplication: FlatApplication;
  preallocatedIdByUniversalIdentifierByMetadataName?: PreallocatedIdByUniversalIdentifierByMetadataName;
  getSearchFieldMetadatasByTsVectorFieldId?: (
    tsVectorFieldMetadataId: string,
  ) => FlatSearchFieldMetadata[];
  // Objects deleted later in this migration, whose fields are dropped one by one first.
  objectUniversalIdentifiersBeingDeleted?: ReadonlySet<string>;
  // Fields joining or leaving a search list in this migration, read before any action ran.
  searchListChanges?: SearchListChange[];
  // Only rebuild markers in this migration: the formula itself changed, so every row is stale.
  isSearchVectorFormulaChange?: boolean;
  // The workspace is converted (IS_SEARCH_VECTOR_TRIGGER_ENABLED), so new tables start in trigger mode.
  isSearchVectorTriggerEnabled?: boolean;
};

export type WorkspaceMigrationActionRunnerContext<
  TFlatAction extends AllFlatWorkspaceMigrationAction,
  TUniversalAction extends AllUniversalWorkspaceMigrationAction =
    AllUniversalWorkspaceMigrationAction,
> = WorkspaceMigrationActionRunnerArgs<TUniversalAction> & {
  flatAction: TFlatAction;
};
