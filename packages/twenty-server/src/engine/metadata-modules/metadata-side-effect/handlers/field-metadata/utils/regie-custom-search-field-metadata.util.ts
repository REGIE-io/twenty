import { isDefined } from 'twenty-shared/utils';

import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { isRegieCustomSearchFieldType } from 'src/engine/workspace-manager/utils/is-regie-search-vector-projection-field-type.util';

type RegieSearchableField = {
  isActive?: boolean;
  settings?: unknown;
  type: Parameters<typeof isRegieCustomSearchFieldType>[0];
};

export const isRegieCustomSearchEnabled = (field: RegieSearchableField) =>
  field.isActive === true &&
  isRegieCustomSearchFieldType(field.type) &&
  (field.settings as { regieCustomField?: { searchable?: boolean } } | null)
    ?.regieCustomField?.searchable === true;

export const buildRegieCustomSearchFieldMetadata = ({
  flatEntity,
  relatedFlatEntityMaps,
}: BuildSideEffectsArgs<'fieldMetadata'>) => {
  const object =
    relatedFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      flatEntity.objectMetadataUniversalIdentifier
    ];

  if (!isDefined(object)) return undefined;

  const tsVector = findTsVectorFlatFieldMetadataForObject({
    fieldUniversalIdentifiers: object.fieldUniversalIdentifiers,
    flatFieldMetadataMaps: relatedFlatEntityMaps.flatFieldMetadataMaps,
  });
  if (!isDefined(tsVector)) return undefined;

  const allSearchRows = Object.values(
    relatedFlatEntityMaps.flatSearchFieldMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);
  if (
    allSearchRows.some(
      (row) =>
        row.fieldMetadataUniversalIdentifier === flatEntity.universalIdentifier,
    )
  ) {
    return undefined;
  }
  const existingRows = allSearchRows.filter(
    (row) =>
      row.objectMetadataUniversalIdentifier === object.universalIdentifier,
  );

  const position =
    existingRows.reduce((max, row) => Math.max(max, row.position), -1) + 1;

  return buildFlatSearchFieldMetadataForField({
    flatObjectMetadata: object,
    flatFieldMetadata: flatEntity,
    tsVectorFlatFieldMetadata: tsVector,
    position,
  });
};

export const findRegieCustomSearchRowsForField = ({
  flatEntity,
  relatedFlatEntityMaps,
}: BuildSideEffectsArgs<'fieldMetadata'>) =>
  Object.fromEntries(
    Object.entries(
      relatedFlatEntityMaps.flatSearchFieldMetadataMaps.byUniversalIdentifier,
    ).filter(
      ([, row]) =>
        isDefined(row) &&
        row.fieldMetadataUniversalIdentifier === flatEntity.universalIdentifier,
    ),
  );
