import { Injectable } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { type MetadataSideEffectResult } from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';
import {
  buildRegieCustomSearchFieldMetadata,
  findRegieCustomSearchRowsForField,
  getRegieCustomSearchMarkerState,
  getRegieCustomSearchPrerequisiteFailure,
  getRegieCustomSearchTargetFailure,
  isRegieCustomSearchEnabled,
} from '../utils/regie-custom-search-field-metadata.util';
import { buildRegieCustomSearchFailure } from '../utils/build-regie-custom-search-failure.util';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';

@Injectable()
export class FieldRegieCustomSearchOnUpdateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'update',
    metadataName: 'fieldMetadata',
    name: 'fieldRegieCustomSearchOnUpdate',
    description:
      'Synchronizes search metadata when a Regie custom field is marked searchable, archived, restored, or deactivated.',
  },
) {
  buildSideEffects(
    args: BuildSideEffectsArgs<'fieldMetadata'>,
  ): MetadataSideEffectResult {
    const previous =
      args.relatedFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
        args.flatEntity.universalIdentifier
      ];
    const markerState = getRegieCustomSearchMarkerState(args.flatEntity);
    if (markerState.status === 'invalid') {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'update',
        code: MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_MARKER_INVALID,
        reason: markerState.reason,
      });
    }
    if (markerState.status === 'unsupported') {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'update',
        code: MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
        reason: `field type ${args.flatEntity.type} has no Regie search projection`,
      });
    }
    if (markerState.status !== 'absent') {
      const targetFailure = getRegieCustomSearchTargetFailure({
        ...args,
        marker: markerState.marker,
      });
      if (targetFailure) {
        return buildRegieCustomSearchFailure({
          flatFieldMetadata: args.flatEntity,
          operation: 'update',
          code: targetFailure.startsWith('marker target')
            ? MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_TARGET_MISMATCH
            : MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
          reason: targetFailure,
        });
      }
    }
    if (markerState.status === 'enabled' && args.flatEntity.isActive === true) {
      const prerequisiteFailure = getRegieCustomSearchPrerequisiteFailure({
        ...args,
        marker: markerState.marker,
      });
      if (prerequisiteFailure) {
        return buildRegieCustomSearchFailure({
          flatFieldMetadata: args.flatEntity,
          operation: 'update',
          code: prerequisiteFailure.startsWith('marker target')
            ? MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_TARGET_MISMATCH
            : MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
          reason: prerequisiteFailure,
        });
      }
    }

    const wasEnabled =
      isDefined(previous) && isRegieCustomSearchEnabled(previous);
    const isEnabled = isRegieCustomSearchEnabled(args.flatEntity);

    if (isEnabled) {
      const searchFieldMetadata = buildRegieCustomSearchFieldMetadata(args);
      // A retry/update is also the repair path for a prior ambiguous response:
      // a matching row is an idempotent noop, a missing row is recreated.
      if (!isDefined(searchFieldMetadata)) return { status: 'noop' };
      return {
        status: 'success',
        operations: {
          searchFieldMetadata: {
            flatEntityToCreate: {
              [searchFieldMetadata.universalIdentifier]: searchFieldMetadata,
            },
          },
        },
      };
    }

    if (!wasEnabled && markerState.status !== 'disabled')
      return { status: 'noop' };

    const rowsToDelete = findRegieCustomSearchRowsForField(args);
    return Object.keys(rowsToDelete).length === 0
      ? { status: 'noop' }
      : {
          status: 'success',
          operations: {
            searchFieldMetadata: { flatEntityToDelete: rowsToDelete },
          },
        };
  }
}
