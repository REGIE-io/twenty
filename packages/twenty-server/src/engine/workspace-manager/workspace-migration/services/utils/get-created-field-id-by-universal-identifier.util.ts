import { isDefined } from 'twenty-shared/utils';

import { type WorkspaceMigration } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration.type';

export const getCreatedFieldIdByUniversalIdentifier = (
  workspaceMigration: WorkspaceMigration,
): Map<string, string> => {
  const fieldIdByUniversalIdentifier = new Map<string, string>();

  for (const action of workspaceMigration.actions) {
    if (action.type !== 'create') continue;

    if (action.metadataName === 'fieldMetadata') {
      if (isDefined(action.id)) {
        fieldIdByUniversalIdentifier.set(
          action.flatEntity.universalIdentifier,
          action.id,
        );
      }

      if (
        isDefined(action.relatedUniversalFlatFieldMetadata) &&
        isDefined(action.relatedFieldId)
      ) {
        fieldIdByUniversalIdentifier.set(
          action.relatedUniversalFlatFieldMetadata.universalIdentifier,
          action.relatedFieldId,
        );
      }
    }

    if (action.metadataName === 'objectMetadata') {
      for (const [universalIdentifier, id] of Object.entries(
        action.fieldIdByUniversalIdentifier ?? {},
      )) {
        fieldIdByUniversalIdentifier.set(universalIdentifier, id);
      }
    }
  }

  return fieldIdByUniversalIdentifier;
};
