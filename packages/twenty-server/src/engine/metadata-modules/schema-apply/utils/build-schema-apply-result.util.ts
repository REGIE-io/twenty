import { isDefined } from 'twenty-shared/utils';

import {
  SchemaApplyException,
  SchemaApplyExceptionCode,
} from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';
import { type SchemaApplyPlan } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-plan.type';
import { type SchemaApplyResult } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-result.type';
import { type SchemaApplySnapshot } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-snapshot.type';

const getOrThrow = <T>(value: T | undefined, description: string): T => {
  if (!isDefined(value)) {
    throw new SchemaApplyException(
      `${description} is missing from the workspace metadata after apply`,
      SchemaApplyExceptionCode.INTERNAL_SERVER_ERROR,
    );
  }

  return value;
};

// `snapshot` must reflect the workspace after the plan was applied.
export const buildSchemaApplyResult = ({
  plan,
  snapshot,
}: {
  plan: SchemaApplyPlan;
  snapshot: SchemaApplySnapshot;
}): SchemaApplyResult => {
  const objectByName = new Map(
    snapshot.objects.map((object) => [object.nameSingular, object]),
  );

  const findField = (objectNameSingular: string, name: string) =>
    getOrThrow(
      objectByName
        .get(objectNameSingular)
        ?.fields.find((field) => field.name === name),
      `Field ${objectNameSingular}.${name}`,
    );

  return {
    objects: plan.objects.map(({ input, isMissing }) => ({
      nameSingular: input.nameSingular,
      id: getOrThrow(
        objectByName.get(input.nameSingular),
        `Object ${input.nameSingular}`,
      ).id,
      created: isMissing,
    })),
    fields: plan.fields.map(({ input, isMissing }) => {
      const field = findField(input.objectNameSingular, input.name);

      return {
        objectNameSingular: input.objectNameSingular,
        name: input.name,
        id: field.id,
        type: field.type,
        created: isMissing,
      };
    }),
    fieldSettings: plan.fieldSettings.map(({ input, isChanged }) => ({
      objectNameSingular: input.objectNameSingular,
      name: input.name,
      updated: isChanged,
    })),
    indexes: plan.indexes.map(({ input, isMissing }) => ({
      objectNameSingular: input.objectNameSingular,
      fieldNames: input.fieldNames,
      id: getOrThrow(
        snapshot.indexes.find(
          (index) =>
            index.objectNameSingular === input.objectNameSingular &&
            index.indexType === input.indexType &&
            index.fieldNames.join(',') === input.fieldNames.join(','),
        ),
        `Index ${input.objectNameSingular}(${input.fieldNames.join(', ')})`,
      ).id,
      created: isMissing,
    })),
    views: plan.views.map(({ input, isMissing }) => ({
      objectNameSingular: input.objectNameSingular,
      name: input.name,
      id: getOrThrow(
        snapshot.views.find(
          (view) =>
            view.objectNameSingular === input.objectNameSingular &&
            view.name.toLowerCase() === input.name.toLowerCase(),
        ),
        `View ${input.name} on ${input.objectNameSingular}`,
      ).id,
      created: isMissing,
    })),
  };
};
