import { Injectable } from '@nestjs/common';

import { msg, t } from '@lingui/core/macro';

import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';
import { buildFieldSideEffectParentNotFoundFailure } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/build-field-side-effect-parent-not-found-failure.util';
import {
  getRegieSearchState,
  resolveRegieSearchRow,
} from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/regie-custom-search.util';
import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import {
  type MetadataSideEffectFailure,
  type MetadataSideEffectResult,
} from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';

@Injectable()
export class FieldRegieSearchOnCreateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'create',
    metadataName: 'fieldMetadata',
    name: 'fieldRegieSearchOnCreate',
    description:
      "When a field created by Regie asks for search through its settings marker, register the searchFieldMetadata row that projects it into the object's searchVector. Custom fields never get such a row on their own, so without this side effect their values stay invisible to per-object full-text search.",
  },
) {
  buildSideEffects({
    flatEntity: flatFieldMetadata,
    allFlatEntityOperationRecordByMetadataName,
    relatedFlatEntityMaps,
  }: BuildSideEffectsArgs<'fieldMetadata'>): MetadataSideEffectResult {
    const regieSearchState = getRegieSearchState(flatFieldMetadata);

    switch (regieSearchState.status) {
      // Not a Regie field at all, or a Regie field whose registration is off: nothing to do.
      case 'absent':
      case 'disabled':
      case 'inactive':
        return { status: 'noop' };
      // Deliberately a no-op and not a failure: the list of projectable types lives in
      // Twenty alone, so Go can send `searchable: true` unconditionally without
      // duplicating that list, and asking for search on a type Twenty cannot project
      // must never fail field creation.
      case 'unsupported':
        return { status: 'noop' };
      case 'invalid': {
        const issues = regieSearchState.issues.join('; ');

        return this.buildRegieSearchFailure({
          flatFieldMetadata,
          message: t`Invalid Regie custom field marker on field "${flatFieldMetadata.name}": ${issues}`,
        });
      }
      case 'enabled':
        break;
    }

    const resolution = resolveRegieSearchRow({
      marker: regieSearchState.marker,
      flatFieldMetadata,
      allFlatEntityOperationRecordByMetadataName,
      relatedFlatEntityMaps,
    });

    if (resolution.outcome === 'parentNotFound') {
      return buildFieldSideEffectParentNotFoundFailure({
        flatFieldMetadata,
        operation: 'create',
      });
    }

    if (resolution.outcome === 'fail') {
      const reason = resolution.message;

      return this.buildRegieSearchFailure({
        flatFieldMetadata,
        message: t`Cannot register field "${flatFieldMetadata.name}" for search: ${reason}`,
      });
    }

    return {
      status: 'success',
      operations: {
        searchFieldMetadata: {
          flatEntityToCreate: {
            [resolution.flatSearchFieldMetadata.universalIdentifier]:
              resolution.flatSearchFieldMetadata,
          },
        },
      },
    };
  }

  private buildRegieSearchFailure({
    flatFieldMetadata,
    message,
  }: {
    flatFieldMetadata: MetadataUniversalFlatEntity<'fieldMetadata'>;
    message: string;
  }): MetadataSideEffectFailure {
    return {
      status: 'fail',
      type: 'create',
      metadataName: 'fieldMetadata',
      flatEntityMinimalInformation: {
        universalIdentifier: flatFieldMetadata.universalIdentifier,
        name: flatFieldMetadata.name,
      },
      errors: [
        {
          code: MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_REGISTRATION_FAILED,
          message,
          userFriendlyMessage: msg`This field could not be registered for search`,
        },
      ],
    };
  }
}
