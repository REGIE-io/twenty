import { isDefined } from 'twenty-shared/utils';

import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import {
  type SchemaApplySnapshot,
  type SchemaApplySnapshotIndex,
  type SchemaApplySnapshotView,
} from 'src/engine/metadata-modules/schema-apply/types/schema-apply-snapshot.type';

const OBJECT_LABEL_PLURAL_TEMPLATE = '{objectLabelPlural}';

export type SchemaApplySnapshotFlatEntityMaps = Pick<
  AllFlatEntityMaps,
  | 'flatObjectMetadataMaps'
  | 'flatFieldMetadataMaps'
  | 'flatIndexMaps'
  | 'flatViewMaps'
>;

export const buildSchemaApplySnapshot = ({
  flatObjectMetadataMaps,
  flatFieldMetadataMaps,
  flatIndexMaps,
  flatViewMaps,
}: SchemaApplySnapshotFlatEntityMaps): SchemaApplySnapshot => {
  const flatObjectMetadatas = Object.values(
    flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  const flatFieldMetadatas = Object.values(
    flatFieldMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);

  const flatFieldMetadatasByObjectId = flatFieldMetadatas.reduce<
    Map<string, FlatFieldMetadata[]>
  >((accumulator, flatFieldMetadata) => {
    accumulator.set(flatFieldMetadata.objectMetadataId, [
      ...(accumulator.get(flatFieldMetadata.objectMetadataId) ?? []),
      flatFieldMetadata,
    ]);

    return accumulator;
  }, new Map());

  const objects = flatObjectMetadatas.map((flatObjectMetadata) => ({
    id: flatObjectMetadata.id,
    nameSingular: flatObjectMetadata.nameSingular,
    fields: (flatFieldMetadatasByObjectId.get(flatObjectMetadata.id) ?? []).map(
      (flatFieldMetadata) => ({
        id: flatFieldMetadata.id,
        name: flatFieldMetadata.name,
        type: flatFieldMetadata.type,
        settings: (flatFieldMetadata.settings ?? null) as Record<
          string,
          unknown
        > | null,
      }),
    ),
  }));

  const indexes = Object.values(flatIndexMaps.byUniversalIdentifier)
    .filter(isDefined)
    .map((flatIndexMetadata): SchemaApplySnapshotIndex | undefined => {
      const flatObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: flatIndexMetadata.objectMetadataId,
        flatEntityMaps: flatObjectMetadataMaps,
      });
      const orderedIndexFields = [
        ...flatIndexMetadata.flatIndexFieldMetadatas,
      ].sort((left, right) => left.order - right.order);
      const fieldNames = orderedIndexFields.map(
        (indexField) =>
          findFlatEntityByIdInFlatEntityMaps({
            flatEntityId: indexField.fieldMetadataId,
            flatEntityMaps: flatFieldMetadataMaps,
          })?.name,
      );

      if (
        !isDefined(flatObjectMetadata) ||
        orderedIndexFields.some((indexField) =>
          isDefined(indexField.subFieldName),
        ) ||
        !fieldNames.every(isDefined)
      ) {
        return undefined;
      }

      return {
        id: flatIndexMetadata.id,
        objectNameSingular: flatObjectMetadata.nameSingular,
        fieldNames,
        indexType: flatIndexMetadata.indexType,
        isUnique: flatIndexMetadata.isUnique,
      };
    })
    .filter(isDefined);

  const views = Object.values(flatViewMaps.byUniversalIdentifier)
    .filter(isDefined)
    .filter((flatView) => !isDefined(flatView.deletedAt))
    .map((flatView): SchemaApplySnapshotView | undefined => {
      const flatObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: flatView.objectMetadataId,
        flatEntityMaps: flatObjectMetadataMaps,
      });

      if (!isDefined(flatObjectMetadata)) {
        return undefined;
      }

      // Same resolution GET /rest/metadata/views applies for the source locale.
      const labelPlural =
        flatObjectMetadata.overrides?.labelPlural ??
        flatObjectMetadata.labelPlural;

      return {
        id: flatView.id,
        objectNameSingular: flatObjectMetadata.nameSingular,
        name: flatView.name.replace(OBJECT_LABEL_PLURAL_TEMPLATE, labelPlural),
      };
    })
    .filter(isDefined);

  return { objects, indexes, views };
};
