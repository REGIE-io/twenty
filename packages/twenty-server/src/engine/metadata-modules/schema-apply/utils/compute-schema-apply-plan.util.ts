import isEqual from 'lodash.isequal';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { PARTIAL_SYSTEM_FLAT_FIELD_METADATAS } from 'src/engine/metadata-modules/object-metadata/constants/partial-system-flat-field-metadatas.constant';
import { type ApplySchemaFieldInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field.input';
import { type ApplySchemaInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema.input';
import {
  SchemaApplyException,
  SchemaApplyExceptionCode,
} from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';
import { type SchemaApplyPlan } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-plan.type';
import { type SchemaApplySnapshot } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-snapshot.type';

type FieldTypesByObjectName = Map<string, Map<string, FieldMetadataType>>;

// Fields a custom object gets at creation: the caller-side name field plus the
// engine's reserved system fields.
const NEW_OBJECT_FIELD_TYPE_BY_NAME = new Map<string, FieldMetadataType>([
  ['name', FieldMetadataType.TEXT],
  ...Object.values(PARTIAL_SYSTEM_FLAT_FIELD_METADATAS).map(
    ({ name, type }) => [name, type] as [string, FieldMetadataType],
  ),
]);

const DEFAULT_INDEX_VIEW_NAME_PREFIX = 'All ';

const toFieldKey = (objectNameSingular: string, name: string) =>
  `${objectNameSingular}.${name}`;

const toIndexKey = ({
  objectNameSingular,
  indexType,
  fieldNames,
}: {
  objectNameSingular: string;
  indexType: IndexType;
  fieldNames: string[];
}) => `${objectNameSingular}|${indexType}|${fieldNames.join(',')}`;

const toViewKey = (objectNameSingular: string, name: string) =>
  `${objectNameSingular}|${name.toLowerCase()}`;

const assertNoDuplicateKeysOrThrow = (keys: string[], entityLabel: string) => {
  const duplicateKey = keys.find((key, index) => keys.indexOf(key) !== index);

  if (isDefined(duplicateKey)) {
    throw new SchemaApplyException(
      `The ${entityLabel} ${duplicateKey} appears more than once in the request`,
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
    );
  }
};

const getObjectFieldTypesOrThrow = ({
  fieldTypesByObjectName,
  objectNameSingular,
  referencedBy,
}: {
  fieldTypesByObjectName: FieldTypesByObjectName;
  objectNameSingular: string;
  referencedBy: string;
}): Map<string, FieldMetadataType> => {
  const fieldTypes = fieldTypesByObjectName.get(objectNameSingular);

  if (!isDefined(fieldTypes)) {
    throw new SchemaApplyException(
      `Object ${objectNameSingular} referenced by ${referencedBy} does not exist and is not created by this request`,
      SchemaApplyExceptionCode.OBJECT_NOT_FOUND,
    );
  }

  return fieldTypes;
};

const assertFieldRelationMatchesTypeOrThrow = (
  input: ApplySchemaFieldInput,
): void => {
  const fieldKey = toFieldKey(input.objectNameSingular, input.name);

  if (input.type === FieldMetadataType.MORPH_RELATION) {
    throw new SchemaApplyException(
      `Field ${fieldKey}: MORPH_RELATION fields are not supported`,
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
    );
  }

  if (input.type === FieldMetadataType.RELATION && !isDefined(input.relation)) {
    throw new SchemaApplyException(
      `Field ${fieldKey}: a RELATION field requires a relation definition`,
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
    );
  }

  if (input.type !== FieldMetadataType.RELATION && isDefined(input.relation)) {
    throw new SchemaApplyException(
      `Field ${fieldKey}: only a RELATION field accepts a relation definition`,
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
    );
  }
};

const computeFieldPlans = ({
  fieldInputs,
  fieldTypesByObjectName,
}: {
  fieldInputs: ApplySchemaFieldInput[];
  fieldTypesByObjectName: FieldTypesByObjectName;
}): SchemaApplyPlan['fields'] => {
  const fieldPlans = fieldInputs.map((input) => {
    const fieldKey = toFieldKey(input.objectNameSingular, input.name);
    const fieldTypes = getObjectFieldTypesOrThrow({
      fieldTypesByObjectName,
      objectNameSingular: input.objectNameSingular,
      referencedBy: `field ${fieldKey}`,
    });

    assertFieldRelationMatchesTypeOrThrow(input);

    const existingType = fieldTypes.get(input.name);

    if (isDefined(existingType)) {
      if (existingType !== input.type) {
        throw new SchemaApplyException(
          `Field ${fieldKey} already exists with type ${existingType}, requested ${input.type}`,
          SchemaApplyExceptionCode.SCHEMA_CONFLICT,
        );
      }

      return { input, isMissing: false };
    }

    if (isDefined(input.relation)) {
      const targetFieldTypes = getObjectFieldTypesOrThrow({
        fieldTypesByObjectName,
        objectNameSingular: input.relation.targetObjectNameSingular,
        referencedBy: `relation ${fieldKey}`,
      });

      if (targetFieldTypes.has(input.relation.targetFieldName)) {
        throw new SchemaApplyException(
          `Relation ${fieldKey} cannot be created: its inverse field ${toFieldKey(input.relation.targetObjectNameSingular, input.relation.targetFieldName)} already exists`,
          SchemaApplyExceptionCode.SCHEMA_CONFLICT,
        );
      }
    }

    return { input, isMissing: true };
  });

  assertNoDuplicateKeysOrThrow(
    fieldInputs.map((input) =>
      toFieldKey(input.objectNameSingular, input.name),
    ),
    'field',
  );
  assertNoDuplicateKeysOrThrow(
    fieldPlans
      .filter(({ isMissing }) => isMissing)
      .flatMap(({ input }) => [
        toFieldKey(input.objectNameSingular, input.name),
        ...(isDefined(input.relation)
          ? [
              toFieldKey(
                input.relation.targetObjectNameSingular,
                input.relation.targetFieldName,
              ),
            ]
          : []),
      ]),
    'created field',
  );

  return fieldPlans;
};

const addPlannedFieldTypes = ({
  fieldTypesByObjectName,
  fieldPlans,
}: {
  fieldTypesByObjectName: FieldTypesByObjectName;
  fieldPlans: SchemaApplyPlan['fields'];
}): FieldTypesByObjectName => {
  const fieldTypesAfterApply: FieldTypesByObjectName = new Map(
    [...fieldTypesByObjectName].map(([objectNameSingular, fieldTypes]) => [
      objectNameSingular,
      new Map(fieldTypes),
    ]),
  );

  fieldPlans
    .filter(({ isMissing }) => isMissing)
    .forEach(({ input }) => {
      fieldTypesAfterApply
        .get(input.objectNameSingular)
        ?.set(input.name, input.type);

      if (isDefined(input.relation)) {
        fieldTypesAfterApply
          .get(input.relation.targetObjectNameSingular)
          ?.set(input.relation.targetFieldName, FieldMetadataType.RELATION);
      }
    });

  return fieldTypesAfterApply;
};

const computeFieldSettingsPlans = ({
  schema,
  snapshot,
}: {
  schema: ApplySchemaInput;
  snapshot: SchemaApplySnapshot;
}): SchemaApplyPlan['fieldSettings'] => {
  const fieldSettingsInputs = schema.fieldSettings ?? [];

  assertNoDuplicateKeysOrThrow(
    fieldSettingsInputs.map((input) =>
      toFieldKey(input.objectNameSingular, input.name),
    ),
    'field settings',
  );

  const snapshotFieldByKey = new Map(
    snapshot.objects.flatMap((object) =>
      object.fields.map((field) => [
        toFieldKey(object.nameSingular, field.name),
        field,
      ]),
    ),
  );

  return fieldSettingsInputs.map((input) => {
    const fieldKey = toFieldKey(input.objectNameSingular, input.name);
    const field = snapshotFieldByKey.get(fieldKey);

    if (!isDefined(field)) {
      throw new SchemaApplyException(
        `Cannot merge settings into field ${fieldKey}: the field does not exist`,
        SchemaApplyExceptionCode.FIELD_NOT_FOUND,
      );
    }

    const currentSettings = field.settings ?? {};

    // Settings are jsonb, so stored keys come back in any order: compare structurally.
    const isChanged = Object.entries(input.settings).some(
      ([key, value]) => !isEqual(currentSettings[key], value),
    );

    return {
      input,
      fieldId: field.id,
      mergedSettings: { ...currentSettings, ...input.settings },
      isChanged,
    };
  });
};

const computeIndexPlans = ({
  schema,
  snapshot,
  fieldTypesAfterApply,
  fieldPlans,
}: {
  schema: ApplySchemaInput;
  snapshot: SchemaApplySnapshot;
  fieldTypesAfterApply: FieldTypesByObjectName;
  fieldPlans: SchemaApplyPlan['fields'];
}): SchemaApplyPlan['indexes'] => {
  // A MANY_TO_ONE relation created now brings its own non-unique join-column index.
  const plannedRelationIndexKeys = fieldPlans
    .filter(({ input, isMissing }) => isMissing && isDefined(input.relation))
    .map(({ input }) =>
      toIndexKey({
        objectNameSingular: input.objectNameSingular,
        indexType: IndexType.BTREE,
        fieldNames: [input.name],
      }),
    );

  const isUniqueByIndexKey = new Map<string, boolean>([
    ...plannedRelationIndexKeys.map((key) => [key, false] as [string, boolean]),
    ...snapshot.indexes.map(
      (index) => [toIndexKey(index), index.isUnique] as [string, boolean],
    ),
  ]);

  const indexPlans = (schema.indexes ?? []).map((rawInput) => {
    const input = {
      ...rawInput,
      indexType: rawInput.indexType ?? IndexType.BTREE,
    };
    const indexKey = toIndexKey(input);
    const fieldTypes = getObjectFieldTypesOrThrow({
      fieldTypesByObjectName: fieldTypesAfterApply,
      objectNameSingular: input.objectNameSingular,
      referencedBy: `index ${indexKey}`,
    });

    const missingFieldName = input.fieldNames.find(
      (fieldName) => !fieldTypes.has(fieldName),
    );

    if (isDefined(missingFieldName)) {
      throw new SchemaApplyException(
        `Index ${indexKey} references field ${toFieldKey(input.objectNameSingular, missingFieldName)}, which does not exist and is not created by this request`,
        SchemaApplyExceptionCode.FIELD_NOT_FOUND,
      );
    }

    assertNoDuplicateKeysOrThrow(
      input.fieldNames,
      `field in index ${indexKey}`,
    );

    const existingIsUnique = isUniqueByIndexKey.get(indexKey);

    if (!isDefined(existingIsUnique)) {
      return { input, isMissing: true };
    }

    if (existingIsUnique !== input.isUnique) {
      throw new SchemaApplyException(
        `Index ${indexKey} already exists with isUnique=${existingIsUnique}, requested isUnique=${input.isUnique}`,
        SchemaApplyExceptionCode.SCHEMA_CONFLICT,
      );
    }

    return { input, isMissing: false };
  });

  assertNoDuplicateKeysOrThrow(
    indexPlans.map(({ input }) => toIndexKey(input)),
    'index',
  );

  return indexPlans;
};

const computeViewPlans = ({
  schema,
  snapshot,
  fieldTypesAfterApply,
  objectPlans,
}: {
  schema: ApplySchemaInput;
  snapshot: SchemaApplySnapshot;
  fieldTypesAfterApply: FieldTypesByObjectName;
  objectPlans: SchemaApplyPlan['objects'];
}): SchemaApplyPlan['views'] => {
  const viewInputs = schema.views ?? [];

  assertNoDuplicateKeysOrThrow(
    viewInputs.map((input) => toViewKey(input.objectNameSingular, input.name)),
    'view',
  );

  // A created object gets the engine's "All {objectLabelPlural}" index view.
  const existingViewKeys = new Set([
    ...snapshot.views.map((view) =>
      toViewKey(view.objectNameSingular, view.name),
    ),
    ...objectPlans
      .filter(({ isMissing }) => isMissing)
      .map(({ input }) =>
        toViewKey(
          input.nameSingular,
          `${DEFAULT_INDEX_VIEW_NAME_PREFIX}${input.labelPlural}`,
        ),
      ),
  ]);

  return viewInputs.map((input) => {
    getObjectFieldTypesOrThrow({
      fieldTypesByObjectName: fieldTypesAfterApply,
      objectNameSingular: input.objectNameSingular,
      referencedBy: `view ${input.name}`,
    });

    return {
      input,
      isMissing: !existingViewKeys.has(
        toViewKey(input.objectNameSingular, input.name),
      ),
    };
  });
};

export const computeSchemaApplyPlan = ({
  schema,
  snapshot,
}: {
  schema: ApplySchemaInput;
  snapshot: SchemaApplySnapshot;
}): SchemaApplyPlan => {
  const objectInputs = schema.objects ?? [];

  assertNoDuplicateKeysOrThrow(
    objectInputs.map((input) => input.nameSingular),
    'object',
  );

  const snapshotObjectNames = new Set(
    snapshot.objects.map((object) => object.nameSingular),
  );
  const objectPlans = objectInputs.map((input) => ({
    input,
    isMissing: !snapshotObjectNames.has(input.nameSingular),
  }));

  const fieldTypesByObjectName: FieldTypesByObjectName = new Map([
    ...snapshot.objects.map(
      (object) =>
        [
          object.nameSingular,
          new Map(object.fields.map((field) => [field.name, field.type])),
        ] as [string, Map<string, FieldMetadataType>],
    ),
    ...objectPlans
      .filter(({ isMissing }) => isMissing)
      .map(
        ({ input }) =>
          [input.nameSingular, new Map(NEW_OBJECT_FIELD_TYPE_BY_NAME)] as [
            string,
            Map<string, FieldMetadataType>,
          ],
      ),
  ]);

  const fieldPlans = computeFieldPlans({
    fieldInputs: schema.fields ?? [],
    fieldTypesByObjectName,
  });
  const fieldTypesAfterApply = addPlannedFieldTypes({
    fieldTypesByObjectName,
    fieldPlans,
  });

  return {
    objects: objectPlans,
    fields: fieldPlans,
    fieldSettings: computeFieldSettingsPlans({ schema, snapshot }),
    indexes: computeIndexPlans({
      schema,
      snapshot,
      fieldTypesAfterApply,
      fieldPlans,
    }),
    views: computeViewPlans({
      schema,
      snapshot,
      fieldTypesAfterApply,
      objectPlans,
    }),
  };
};

export const hasSchemaApplyPlanChanges = (plan: SchemaApplyPlan): boolean =>
  [...plan.objects, ...plan.fields, ...plan.indexes, ...plan.views].some(
    ({ isMissing }) => isMissing,
  ) || plan.fieldSettings.some(({ isChanged }) => isChanged);
