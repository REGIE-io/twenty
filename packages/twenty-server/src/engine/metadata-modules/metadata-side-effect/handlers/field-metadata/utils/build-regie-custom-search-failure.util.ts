import { msg, t } from '@lingui/core/macro';

import { type MetadataFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-flat-entity.type';
import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';
import { type MetadataSideEffectFailure } from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';
import { type WorkspaceMigrationActionType } from 'src/engine/metadata-modules/flat-entity/types/metadata-workspace-migration-action.type';

export const buildRegieCustomSearchFailure = ({
  flatFieldMetadata,
  operation,
  code,
  reason,
}: {
  flatFieldMetadata: MetadataUniversalFlatEntity<'fieldMetadata'>;
  operation: WorkspaceMigrationActionType;
  code:
    | MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_MARKER_INVALID
    | MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE
    | MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_TARGET_MISMATCH;
  reason: string;
}): MetadataSideEffectFailure => ({
  status: 'fail',
  type: operation,
  metadataName: 'fieldMetadata',
  flatEntityMinimalInformation: {
    universalIdentifier: flatFieldMetadata.universalIdentifier,
    name: flatFieldMetadata.name,
  } as Partial<MetadataFlatEntity<'fieldMetadata'>>,
  errors: [
    {
      code,
      message: t`Regie custom-field search metadata could not be applied: ${reason}`,
      userFriendlyMessage: msg`This custom field cannot be saved until its search configuration is valid`,
    },
  ],
});
