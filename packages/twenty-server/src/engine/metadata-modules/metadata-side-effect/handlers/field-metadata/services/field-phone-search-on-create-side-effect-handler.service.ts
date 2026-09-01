import { Injectable } from '@nestjs/common';

import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { PHONE_SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/phone-search-vector-field.constants';
import { resolveParentFlatObjectMetadataAfterStateForFieldSideEffect } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/resolve-parent-flat-object-metadata-after-state-for-field-side-effect.util';
import {
  type BuildSideEffectsArgs,
  MetadataSideEffectHandler,
} from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { type MetadataSideEffectResult } from 'src/engine/metadata-modules/metadata-side-effect/types/metadata-side-effect-result.type';
import { type UniversalFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-field-metadata.type';

@Injectable()
export class FieldPhoneSearchOnCreateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'create',
    metadataName: 'fieldMetadata',
    name: 'fieldPhoneSearchOnCreate',
    description:
      'Adds active custom Person PHONES fields to the phone-only search vector.',
  },
) {
  buildSideEffects({
    flatEntity,
    allFlatEntityOperationRecordByMetadataName,
    relatedFlatEntityMaps,
  }: BuildSideEffectsArgs<'fieldMetadata'>): MetadataSideEffectResult {
    const field = flatEntity as UniversalFlatFieldMetadata;
    if (
      field.type !== FieldMetadataType.PHONES ||
      !field.isActive ||
      field.objectMetadataUniversalIdentifier !==
        STANDARD_OBJECTS.person.universalIdentifier
    )
      return { status: 'noop' };
    const object = resolveParentFlatObjectMetadataAfterStateForFieldSideEffect({
      objectMetadataUniversalIdentifier:
        field.objectMetadataUniversalIdentifier,
      allFlatEntityOperationRecordByMetadataName,
      relatedFlatEntityMaps,
    });
    const target = isDefined(object)
      ? object.fieldUniversalIdentifiers
          .map(
            (id) =>
              relatedFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
                id
              ],
          )
          .find(
            (candidate) => candidate?.name === PHONE_SEARCH_VECTOR_FIELD.name,
          )
      : undefined;
    if (!isDefined(object) || !isDefined(target)) return { status: 'noop' };
    const searchField = buildFlatSearchFieldMetadataForField({
      flatObjectMetadata: object,
      flatFieldMetadata: field,
      tsVectorFlatFieldMetadata: target,
      position: 0,
      useTargetAwareIdentifier: true,
    });
    return {
      status: 'success',
      operations: {
        searchFieldMetadata: {
          flatEntityToCreate: {
            [searchField.universalIdentifier]: searchField,
          },
        },
      },
    };
  }
}
