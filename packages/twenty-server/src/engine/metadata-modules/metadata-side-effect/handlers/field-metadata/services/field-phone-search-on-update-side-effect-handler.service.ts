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
export class FieldPhoneSearchOnUpdateSideEffectHandlerService extends MetadataSideEffectHandler(
  {
    operation: 'update',
    metadataName: 'fieldMetadata',
    name: 'fieldPhoneSearchOnUpdate',
    description:
      'Keeps Person PHONES participation in the phone-only vector aligned with activation changes.',
  },
) {
  buildSideEffects({
    flatEntity,
    allFlatEntityOperationRecordByMetadataName,
    relatedFlatEntityMaps,
  }: BuildSideEffectsArgs<'fieldMetadata'>): MetadataSideEffectResult {
    const next = flatEntity as UniversalFlatFieldMetadata;
    const previous =
      relatedFlatEntityMaps.flatFieldMetadataMaps.byUniversalIdentifier[
        next.universalIdentifier
      ];
    if (
      !isDefined(previous) ||
      next.objectMetadataUniversalIdentifier !==
        STANDARD_OBJECTS.person.universalIdentifier ||
      next.type !== FieldMetadataType.PHONES
    )
      return { status: 'noop' };
    if (previous.isActive === next.isActive) return { status: 'noop' };
    const existingPhoneContribution =
      previous.searchFieldMetadataUniversalIdentifiers
        .map(
          (id) =>
            relatedFlatEntityMaps.flatSearchFieldMetadataMaps
              .byUniversalIdentifier[id],
        )
        .find((searchField) =>
          isDefined(searchField)
            ? searchField.tsVectorFieldMetadataUniversalIdentifier ===
              STANDARD_OBJECTS.person.fields.phoneSearchVector
                .universalIdentifier
            : false,
        );
    if (!next.isActive) {
      return isDefined(existingPhoneContribution)
        ? {
            status: 'success',
            operations: {
              searchFieldMetadata: {
                flatEntityToDelete: {
                  [existingPhoneContribution.universalIdentifier]:
                    existingPhoneContribution,
                },
              },
            },
          }
        : { status: 'noop' };
    }
    const object = resolveParentFlatObjectMetadataAfterStateForFieldSideEffect({
      objectMetadataUniversalIdentifier: next.objectMetadataUniversalIdentifier,
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
          .find((field) => field?.name === PHONE_SEARCH_VECTOR_FIELD.name)
      : undefined;
    if (
      !isDefined(object) ||
      !isDefined(target) ||
      isDefined(existingPhoneContribution)
    )
      return { status: 'noop' };
    const searchField = buildFlatSearchFieldMetadataForField({
      flatObjectMetadata: object,
      flatFieldMetadata: next,
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
