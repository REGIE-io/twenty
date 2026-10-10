import { msg } from '@lingui/core/macro';
import { MAX_CUSTOM_INDEXES_PER_OBJECT } from 'twenty-shared/constants';
import { RelationType } from 'twenty-shared/types';
import { v4 } from 'uuid';

import { isCompositeFieldMetadataType } from 'src/engine/metadata-modules/field-metadata/utils/is-composite-field-metadata-type.util';
import { isMorphOrRelationUniversalFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import {
  IndexMetadataException,
  IndexMetadataExceptionCode,
} from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';
import { generateFlatIndexMetadataWithNameOrThrow } from 'src/engine/metadata-modules/index-metadata/utils/generate-flat-index.util';
import { validateIndexTypeAgainstFieldsOrThrow } from 'src/engine/metadata-modules/index-metadata/utils/validate-index-type-against-fields.util';
import { type SchemaApplyPlannedIndex } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-plan.type';
import { type UniversalFlatFieldMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-field-metadata.type';
import { type UniversalFlatIndexMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-index-metadata.type';
import { type UniversalFlatObjectMetadata } from 'src/engine/workspace-manager/workspace-migration/universal-flat-entity/types/universal-flat-object-metadata.type';

// Universal counterpart of IndexMetadataService's builder: the object and fields may be
// created in the same migration, so they are resolved by universal identifier, not id.
export const buildUniversalFlatIndexForSchemaApply = ({
  index,
  flatObjectMetadata,
  orderedFlatFieldMetadatas,
  customIndexCountOnObject,
  applicationUniversalIdentifier,
  createdAt,
}: {
  index: SchemaApplyPlannedIndex;
  flatObjectMetadata: UniversalFlatObjectMetadata;
  orderedFlatFieldMetadatas: UniversalFlatFieldMetadata[];
  customIndexCountOnObject: number;
  applicationUniversalIdentifier: string;
  createdAt: string;
}): UniversalFlatIndexMetadata => {
  orderedFlatFieldMetadatas.forEach((flatFieldMetadata) => {
    if (
      isMorphOrRelationUniversalFlatFieldMetadata(flatFieldMetadata) &&
      flatFieldMetadata.universalSettings?.relationType !==
        RelationType.MANY_TO_ONE
    ) {
      throw new IndexMetadataException(
        `Field ${flatFieldMetadata.name} is a non-MANY_TO_ONE relation and has no join column to index`,
        IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_MORH_RELATION_FIELD_AND_RELATION_FIELD,
      );
    }

    if (isCompositeFieldMetadataType(flatFieldMetadata.type)) {
      throw new IndexMetadataException(
        `Composite field ${flatFieldMetadata.name} cannot be indexed as a whole`,
        IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_COMPOSITE_FIELD,
        {
          userFriendlyMessage: msg`Composite fields can't be indexed as a whole.`,
        },
      );
    }
  });

  validateIndexTypeAgainstFieldsOrThrow({
    indexType: index.indexType,
    fields: orderedFlatFieldMetadatas.map(({ type, name, label }) => ({
      type,
      name,
      label,
      subFieldName: null,
    })),
  });

  if (customIndexCountOnObject >= MAX_CUSTOM_INDEXES_PER_OBJECT) {
    throw new IndexMetadataException(
      `Custom index limit of ${MAX_CUSTOM_INDEXES_PER_OBJECT} reached for object ${flatObjectMetadata.nameSingular}`,
      IndexMetadataExceptionCode.CUSTOM_INDEX_LIMIT_REACHED,
    );
  }

  const indexMetadataUniversalIdentifier = v4();

  return generateFlatIndexMetadataWithNameOrThrow({
    flatObjectMetadata,
    objectFlatFieldMetadatas: orderedFlatFieldMetadatas,
    flatIndex: {
      createdAt,
      updatedAt: createdAt,
      indexType: index.indexType,
      indexWhereClause: null,
      isCustom: true,
      isUnique: index.isUnique,
      isSystemSideEffect: false,
      objectMetadataUniversalIdentifier: flatObjectMetadata.universalIdentifier,
      universalIdentifier: indexMetadataUniversalIdentifier,
      applicationUniversalIdentifier,
      universalFlatIndexFieldMetadatas: orderedFlatFieldMetadatas.map(
        (flatFieldMetadata, order) => ({
          createdAt,
          updatedAt: createdAt,
          order,
          subFieldName: null,
          fieldMetadataUniversalIdentifier:
            flatFieldMetadata.universalIdentifier,
          indexMetadataUniversalIdentifier,
        }),
      ),
    },
  });
};
