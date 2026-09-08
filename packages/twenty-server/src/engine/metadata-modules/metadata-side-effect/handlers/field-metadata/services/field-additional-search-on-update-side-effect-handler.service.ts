import { Injectable } from '@nestjs/common';

import { msg, t } from '@lingui/core/macro';

import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';
import { buildFieldSideEffectParentNotFoundFailure } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/build-field-side-effect-parent-not-found-failure.util';
import {
  findRegisteredAdditionalSearchRows,
  getAdditionalSearchState,
  resolveAdditionalSearchRow,
} from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/additional-search.util';
import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import {
  type MetadataSideEffectFailure,
  type MetadataSideEffectResult,
} from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';

@Injectable()
export class FieldAdditionalSearchOnUpdateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'update',
    metadataName: 'fieldMetadata',
    name: 'fieldAdditionalSearchOnUpdate',
    description:
      "Keeps a marked field's searchFieldMetadata registration in step with its marker and its active state, so turning search off, archiving, or restoring a field adds or removes it from the object's searchVector.",
  },
) {
  buildSideEffects({
    flatEntity: flatFieldMetadata,
    allFlatEntityOperationRecordByMetadataName,
    relatedFlatEntityMaps,
  }: BuildSideEffectsArgs<'fieldMetadata'>): MetadataSideEffectResult {
    const additionalSearchState = getAdditionalSearchState(flatFieldMetadata);

    if (additionalSearchState.status === 'absent') {
      return { status: 'noop' };
    }

    if (additionalSearchState.status === 'invalid') {
      const issues = additionalSearchState.issues.join('; ');

      return this.buildAdditionalSearchFailure({
        flatFieldMetadata,
        message: t`Invalid additional-search marker on field "${flatFieldMetadata.name}": ${issues}`,
      });
    }

    // There is no pre-update entity to diff against, so intent is reconciled against the
    // rows that already exist. That also makes the handler idempotent, which is what lets a
    // retried update settle the same field rather than registering it twice.
    const shouldBeRegistered = additionalSearchState.status === 'enabled';
    const registeredRows = findRegisteredAdditionalSearchRows({
      flatFieldMetadata,
      relatedFlatEntityMaps,
    });
    const isRegistered = Object.keys(registeredRows).length > 0;

    if (shouldBeRegistered === isRegistered) {
      return { status: 'noop' };
    }

    if (!shouldBeRegistered) {
      return {
        status: 'success',
        operations: {
          searchFieldMetadata: { flatEntityToDelete: registeredRows },
        },
      };
    }

    const resolution = resolveAdditionalSearchRow({
      marker: additionalSearchState.marker,
      flatFieldMetadata,
      allFlatEntityOperationRecordByMetadataName,
      relatedFlatEntityMaps,
    });

    if (resolution.outcome === 'parentNotFound') {
      return buildFieldSideEffectParentNotFoundFailure({
        flatFieldMetadata,
        operation: 'update',
      });
    }

    if (resolution.outcome === 'fail') {
      const reason = resolution.message;

      return this.buildAdditionalSearchFailure({
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

  private buildAdditionalSearchFailure({
    flatFieldMetadata,
    message,
  }: {
    flatFieldMetadata: MetadataUniversalFlatEntity<'fieldMetadata'>;
    message: string;
  }): MetadataSideEffectFailure {
    return {
      status: 'fail',
      type: 'update',
      metadataName: 'fieldMetadata',
      flatEntityMinimalInformation: {
        universalIdentifier: flatFieldMetadata.universalIdentifier,
        name: flatFieldMetadata.name,
      },
      errors: [
        {
          code: MetadataSideEffectExceptionCode.ADDITIONAL_SEARCH_REGISTRATION_FAILED,
          message,
          userFriendlyMessage: msg`This field could not be registered for search`,
        },
      ],
    };
  }
}
