import {
  parseRegieCustomFieldMarker,
  type FieldMetadataType,
  type RegieCustomFieldMarker,
} from 'twenty-shared/types';

import { isDefined } from 'twenty-shared/utils';

import { type MetadataUniversalFlatEntity } from 'src/engine/metadata-modules/flat-entity/types/metadata-universal-flat-entity.type';
import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { resolveParentFlatObjectMetadataAfterStateForFieldSideEffect } from 'src/engine/metadata-modules/metadata-side-effect/handlers/field-metadata/utils/resolve-parent-flat-object-metadata-after-state-for-field-side-effect.util';
import { type BuildSideEffectsArgs } from 'src/engine/metadata-modules/metadata-side-effect/interfaces/base-metadata-side-effect-handler.service';
import { SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/search-vector-field.constants';
import { isRegieSearchableFieldType } from 'src/engine/workspace-manager/utils/is-regie-searchable-field-type.util';
import { type UniversalFlatSearchFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-search-field-metadata.type';

// The minimal shape both the create and update side-effect handlers can supply: a
// UniversalFlatFieldMetadata satisfies this, and so does a bare test fixture. Keeping this
// narrow (rather than depending on UniversalFlatFieldMetadata directly) is what lets this
// module stay usable by both handlers without assuming either one's call shape.
export type RegieSearchableField = {
  type: FieldMetadataType;
  isActive?: boolean;
  universalSettings?: unknown;
};

export type RegieSearchState =
  | { status: 'absent' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'disabled'; marker: RegieCustomFieldMarker }
  | { status: 'inactive'; marker: RegieCustomFieldMarker }
  | { status: 'unsupported'; marker: RegieCustomFieldMarker }
  | { status: 'enabled'; marker: RegieCustomFieldMarker };

export const getRegieSearchState = (
  field: RegieSearchableField,
): RegieSearchState => {
  const parsed = parseRegieCustomFieldMarker(field.universalSettings);

  if (parsed.status === 'absent') {
    return { status: 'absent' };
  }

  if (parsed.status === 'invalid') {
    return { status: 'invalid', issues: parsed.issues };
  }

  const { marker } = parsed;

  // Precedence is deliberate, not incidental: a field can be simultaneously disabled,
  // unsupported and inactive, and callers need exactly one status back. We check
  // `disabled` first because it is what Go actually asked for (searchable: false), then
  // `unsupported` because it is the more actionable fact for a caller than `inactive` -
  // re-activating an unsupported-type field would still not make it searchable, whereas
  // learning "unsupported" tells the caller the type itself can never be searched.
  if (!marker.searchable) {
    return { status: 'disabled', marker };
  }

  if (!isRegieSearchableFieldType(field.type)) {
    return { status: 'unsupported', marker };
  }

  if (field.isActive === false) {
    return { status: 'inactive', marker };
  }

  return { status: 'enabled', marker };
};

export const isRegieSearchEnabled = (field: RegieSearchableField): boolean =>
  getRegieSearchState(field).status === 'enabled';

// The marker names the object in Regie's vocabulary; Twenty names it differently. Checking
// them against each other catches a caller that created a person field against the company
// object, which is a real risk because of exactly this naming gap.
const TWENTY_OBJECT_NAME_BY_TARGET: Record<
  RegieCustomFieldMarker['target'],
  string
> = {
  person: 'person',
  account: 'company',
  task: 'task',
  calendar_event: 'calendarEvent',
};

export const getRegieSearchTargetMismatch = ({
  marker,
  objectNameSingular,
}: {
  marker: RegieCustomFieldMarker;
  objectNameSingular: string;
}): string | undefined => {
  const expectedObjectNameSingular =
    TWENTY_OBJECT_NAME_BY_TARGET[marker.target];

  if (expectedObjectNameSingular === objectNameSingular) {
    return undefined;
  }

  return `marker target ${marker.target} does not match object ${objectNameSingular}`;
};

// The create and update handlers both have to answer the same question once a marker says
// a field should be searchable: which searchFieldMetadata row represents it, and is the
// object in a fit state to carry one. Kept here so the two handlers cannot drift.
export type RegieSearchRowResolution =
  | { outcome: 'parentNotFound' }
  | { outcome: 'fail'; message: string }
  | {
      outcome: 'row';
      flatSearchFieldMetadata: UniversalFlatSearchFieldMetadata;
    };

export const resolveRegieSearchRow = ({
  marker,
  flatFieldMetadata,
  allFlatEntityOperationRecordByMetadataName,
  relatedFlatEntityMaps,
}: {
  marker: RegieCustomFieldMarker;
} & Pick<
  BuildSideEffectsArgs<'fieldMetadata'>,
  'allFlatEntityOperationRecordByMetadataName' | 'relatedFlatEntityMaps'
> & {
    flatFieldMetadata: MetadataUniversalFlatEntity<'fieldMetadata'>;
  }): RegieSearchRowResolution => {
  const parentFlatObjectMetadata =
    resolveParentFlatObjectMetadataAfterStateForFieldSideEffect({
      objectMetadataUniversalIdentifier:
        flatFieldMetadata.objectMetadataUniversalIdentifier,
      allFlatEntityOperationRecordByMetadataName,
      relatedFlatEntityMaps,
    });

  if (!isDefined(parentFlatObjectMetadata)) {
    return { outcome: 'parentNotFound' };
  }

  // Regie names the object `account` where Twenty names it `company`, and that gap has
  // already produced a wrong-object bug, so a field pointed at the wrong object fails
  // loudly instead of being indexed in the wrong place.
  const targetMismatch = getRegieSearchTargetMismatch({
    marker,
    objectNameSingular: parentFlatObjectMetadata.nameSingular,
  });

  if (isDefined(targetMismatch)) {
    return { outcome: 'fail', message: targetMismatch };
  }

  const tsVectorFlatFieldMetadata = findTsVectorFlatFieldMetadataForObject({
    fieldUniversalIdentifiers:
      parentFlatObjectMetadata.fieldUniversalIdentifiers,
    flatFieldMetadataMaps: relatedFlatEntityMaps.flatFieldMetadataMaps,
  });

  if (!isDefined(tsVectorFlatFieldMetadata)) {
    return {
      outcome: 'fail',
      message: `object "${parentFlatObjectMetadata.nameSingular}" has no ${SEARCH_VECTOR_FIELD.name} field`,
    };
  }

  return {
    outcome: 'row',
    // Position 0 is intentional: ordering inside the search expression exists only to
    // reduce churn, and the expression builder tie-breaks on universal identifier.
    flatSearchFieldMetadata: buildFlatSearchFieldMetadataForField({
      flatObjectMetadata: parentFlatObjectMetadata,
      flatFieldMetadata,
      tsVectorFlatFieldMetadata,
      position: 0,
    }),
  };
};

// A field records the search rows that index it, so "is this already registered" is a
// property of the field rather than a scan of every row.
export const findRegisteredRegieSearchRows = ({
  flatFieldMetadata,
  relatedFlatEntityMaps,
}: {
  flatFieldMetadata: MetadataUniversalFlatEntity<'fieldMetadata'>;
  relatedFlatEntityMaps: BuildSideEffectsArgs<'fieldMetadata'>['relatedFlatEntityMaps'];
}): Record<string, MetadataUniversalFlatEntity<'searchFieldMetadata'>> => {
  const rows: Record<
    string,
    MetadataUniversalFlatEntity<'searchFieldMetadata'>
  > = {};

  for (const universalIdentifier of flatFieldMetadata.searchFieldMetadataUniversalIdentifiers) {
    const flatSearchFieldMetadata =
      relatedFlatEntityMaps.flatSearchFieldMetadataMaps?.byUniversalIdentifier[
        universalIdentifier
      ];

    if (isDefined(flatSearchFieldMetadata)) {
      rows[flatSearchFieldMetadata.universalIdentifier] =
        flatSearchFieldMetadata;
    }
  }

  return rows;
};
