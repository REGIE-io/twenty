import { Injectable } from '@nestjs/common';

import { msg, t } from '@lingui/core/macro';

import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';
import { buildFieldSideEffectParentNotFoundFailure } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/build-field-side-effect-parent-not-found-failure.util';
import {
  findRegisteredRegieSearchRows,
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
export class FieldRegieSearchOnUpdateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'update',
    metadataName: 'fieldMetadata',
    name: 'fieldRegieSearchOnUpdate',
    description:
      "Keeps a Regie field's searchFieldMetadata registration in step with its marker and its active state, so turning search off, archiving, or restoring a field adds or removes it from the object's searchVector.",
  },
) {
  buildSideEffects({
    flatEntity: flatFieldMetadata,
    allFlatEntityOperationRecordByMetadataName,
    relatedFlatEntityMaps,
  }: BuildSideEffectsArgs<'fieldMetadata'>): MetadataSideEffectResult {
    const regieSearchState = getRegieSearchState(flatFieldMetadata);

    if (regieSearchState.status === 'absent') {
      return { status: 'noop' };
    }

    if (regieSearchState.status === 'invalid') {
      const issues = regieSearchState.issues.join('; ');

      return this.buildRegieSearchFailure({
        flatFieldMetadata,
        message: t`Invalid Regie custom field marker on field "${flatFieldMetadata.name}": ${issues}`,
      });
    }

    // There is no pre-update entity to diff against, so intent is reconciled against the
    // rows that already exist. That also makes the handler idempotent, which is what lets a
    // retried update settle the same field rather than registering it twice.
    const shouldBeRegistered = regieSearchState.status === 'enabled';
    const registeredRows = findRegisteredRegieSearchRows({
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

    const resolution = resolveRegieSearchRow({
      marker: regieSearchState.marker,
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
      type: 'update',
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
