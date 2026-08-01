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
  isRegieCustomSearchEnabled,
} from '../utils/regie-custom-search-field-metadata.util';

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
    const wasEnabled =
      isDefined(previous) && isRegieCustomSearchEnabled(previous);
    const isEnabled = isRegieCustomSearchEnabled(args.flatEntity);
    if (wasEnabled === isEnabled) return { status: 'noop' };

    if (isEnabled) {
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
