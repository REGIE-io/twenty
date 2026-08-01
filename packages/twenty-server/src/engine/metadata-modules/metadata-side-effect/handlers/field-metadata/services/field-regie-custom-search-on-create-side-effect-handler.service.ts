import { Injectable } from '@nestjs/common';

import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { type MetadataSideEffectResult } from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';
import {
  buildRegieCustomSearchFieldMetadata,
  isRegieCustomSearchEnabled,
} from '../utils/regie-custom-search-field-metadata.util';

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
    if (!isRegieCustomSearchEnabled(args.flatEntity)) return { status: 'noop' };

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
