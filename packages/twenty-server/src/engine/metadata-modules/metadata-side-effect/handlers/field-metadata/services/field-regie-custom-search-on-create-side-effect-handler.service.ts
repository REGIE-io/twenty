import { Injectable } from '@nestjs/common';

import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { type MetadataSideEffectResult } from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';
import {
  buildRegieCustomSearchFieldMetadata,
  getRegieCustomSearchMarkerState,
  getRegieCustomSearchPrerequisiteFailure,
  getRegieCustomSearchTargetFailure,
} from '../utils/regie-custom-search-field-metadata.util';
import { buildRegieCustomSearchFailure } from '../utils/build-regie-custom-search-failure.util';
import { MetadataSideEffectExceptionCode } from 'src/engine/metadata-modules/metadata-side-effect/exceptions/metadata-side-effect-exception-code';

@Injectable()
export class FieldRegieCustomSearchOnCreateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'create',
    metadataName: 'fieldMetadata',
    name: 'fieldRegieCustomSearchOnCreate',
    description:
      'Registers an active Regie-approved custom field in its object searchVector only when the namespaced searchable marker is set.',
  },
) {
  buildSideEffects(
    args: BuildSideEffectsArgs<'fieldMetadata'>,
  ): MetadataSideEffectResult {
    const markerState = getRegieCustomSearchMarkerState(args.flatEntity);
    if (markerState.status === 'absent') {
      return { status: 'noop' };
    }
    if (markerState.status === 'invalid') {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'create',
        code: MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_MARKER_INVALID,
        reason: markerState.reason,
      });
    }
    if (markerState.status === 'unsupported') {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'create',
        code: MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
        reason: `field type ${args.flatEntity.type} has no Regie search projection`,
      });
    }
    const targetFailure = getRegieCustomSearchTargetFailure({
      ...args,
      marker: markerState.marker,
    });
    if (targetFailure) {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'create',
        code: targetFailure.startsWith('marker target')
          ? MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_TARGET_MISMATCH
          : MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
        reason: targetFailure,
      });
    }
    if (markerState.status === 'disabled') return { status: 'noop' };
    if (args.flatEntity.isActive !== true) return { status: 'noop' };

    const prerequisiteFailure = getRegieCustomSearchPrerequisiteFailure({
      ...args,
      marker: markerState.marker,
    });
    if (prerequisiteFailure) {
      return buildRegieCustomSearchFailure({
        flatFieldMetadata: args.flatEntity,
        operation: 'create',
        code: prerequisiteFailure.startsWith('marker target')
          ? MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_TARGET_MISMATCH
          : MetadataSideEffectExceptionCode.REGIE_CUSTOM_FIELD_SEARCH_UNAVAILABLE,
        reason: prerequisiteFailure,
      });
    }

    const searchFieldMetadata = buildRegieCustomSearchFieldMetadata(args);
    if (!searchFieldMetadata) return { status: 'noop' };

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
}
