import {
  parseRegieCustomFieldMarker,
  type RegieCustomFieldMarker,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { isRegieCustomSearchFieldType } from 'src/engine/workspace-manager/utils/is-regie-search-vector-projection-field-type.util';

type RegieSearchableField = {
  isActive?: boolean;
  universalSettings?: unknown;
  type: Parameters<typeof isRegieCustomSearchFieldType>[0];
};

export type RegieCustomSearchMarkerState =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'disabled'; marker: RegieCustomFieldMarker }
  | { status: 'enabled'; marker: RegieCustomFieldMarker }
  | { status: 'unsupported'; marker: RegieCustomFieldMarker };

export const getRegieCustomSearchMarkerState = (
  field: RegieSearchableField,
): RegieCustomSearchMarkerState => {
  const marker = parseRegieCustomFieldMarker(field.universalSettings);
  if (marker.status === 'absent') return marker;
  if (marker.status === 'invalid') {
    return { status: 'invalid', reason: marker.issues.join('; ') };
  }
  if (marker.marker.searchable === false) {
    return { status: 'disabled', marker: marker.marker };
  }
  return isRegieCustomSearchFieldType(field.type)
    ? { status: 'enabled', marker: marker.marker }
    : { status: 'unsupported', marker: marker.marker };
};

export const isRegieCustomSearchEnabled = (field: RegieSearchableField) =>
  field.isActive === true &&
  getRegieCustomSearchMarkerState(field).status === 'enabled';

export const getRegieCustomSearchTargetFailure = ({
  flatEntity,
  relatedFlatEntityMaps,
  marker,
}: Pick<
  BuildSideEffectsArgs<'fieldMetadata'>,
  'flatEntity' | 'relatedFlatEntityMaps'
> & {
  marker: RegieCustomFieldMarker;
}): string | undefined => {
  const object =
    relatedFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      flatEntity.objectMetadataUniversalIdentifier
    ];
  if (!isDefined(object)) return 'parent object metadata is missing';

  const expectedObjectName =
    marker.target === 'account'
      ? 'company'
      : marker.target === 'calendar_event'
        ? 'calendarEvent'
        : marker.target;
  if (object.nameSingular !== expectedObjectName) {
    return `marker target ${marker.target} does not match object ${object.nameSingular}`;
  }

  return undefined;
};

export const getRegieCustomSearchPrerequisiteFailure = ({
  flatEntity,
  relatedFlatEntityMaps,
  marker,
}: Pick<
  BuildSideEffectsArgs<'fieldMetadata'>,
  'flatEntity' | 'relatedFlatEntityMaps'
> & {
  marker: RegieCustomFieldMarker;
}): string | undefined => {
  const targetFailure = getRegieCustomSearchTargetFailure({
    flatEntity,
    relatedFlatEntityMaps,
    marker,
  });
  if (targetFailure) return targetFailure;

  const object =
    relatedFlatEntityMaps.flatObjectMetadataMaps.byUniversalIdentifier[
      flatEntity.objectMetadataUniversalIdentifier
    ];
  if (!isDefined(object)) return 'parent object metadata is missing';

  if (!isRegieCustomSearchFieldType(flatEntity.type)) {
    return `field type ${flatEntity.type} has no Regie search projection`;
  }

  const tsVector = findTsVectorFlatFieldMetadataForObject({
    fieldUniversalIdentifiers: object.fieldUniversalIdentifiers,
    flatFieldMetadataMaps: relatedFlatEntityMaps.flatFieldMetadataMaps,
  });
  if (!isDefined(tsVector)) return 'object has no searchVector TS_VECTOR field';

  return undefined;
};

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
