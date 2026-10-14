import {
  FieldMetadataType,
  RelationOnDeleteAction,
  RelationType,
  ViewType,
} from 'twenty-shared/types';

import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { type ApplySchemaFieldInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-field.input';
import { type ApplySchemaObjectInput } from 'src/engine/metadata-modules/schema-apply/dtos/apply-schema-object.input';
import {
  SchemaApplyException,
  SchemaApplyExceptionCode,
} from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';
import { type SchemaApplySnapshot } from 'src/engine/metadata-modules/schema-apply/types/schema-apply-snapshot.type';
import {
  computeSchemaApplyPlan,
  hasSchemaApplyPlanChanges,
} from 'src/engine/metadata-modules/schema-apply/utils/compute-schema-apply-plan.util';

const SNAPSHOT: SchemaApplySnapshot = {
  objects: [
    {
      id: 'person-id',
      nameSingular: 'person',
      fields: [
        {
          id: 'person-name-id',
          name: 'name',
          type: FieldMetadataType.FULL_NAME,
          settings: null,
        },
        {
          id: 'person-emails-id',
          name: 'emails',
          type: FieldMetadataType.EMAILS,
          settings: {
            maxNumberOfValues: 5,
            marker: { version: 1, target: 'person', searchable: true },
          },
        },
        {
          id: 'person-external-id',
          name: 'externalId',
          type: FieldMetadataType.TEXT,
          settings: null,
        },
      ],
    },
  ],
  indexes: [
    {
      id: 'person-external-id-index',
      objectNameSingular: 'person',
      fieldNames: ['externalId'],
      indexType: IndexType.BTREE,
      isUnique: true,
    },
  ],
  views: [
    { id: 'all-people-view', objectNameSingular: 'person', name: 'All People' },
  ],
};

const REGIE_LIST_OBJECT: ApplySchemaObjectInput = {
  nameSingular: 'regieList',
  namePlural: 'regieLists',
  labelSingular: 'Regie List',
  labelPlural: 'Regie Lists',
};

const REGIE_LIST_MEMBERSHIP_OBJECT: ApplySchemaObjectInput = {
  nameSingular: 'regieListMembership',
  namePlural: 'regieListMemberships',
  labelSingular: 'Regie List Membership',
  labelPlural: 'Regie List Memberships',
};

const LIST_RELATION_FIELD: ApplySchemaFieldInput = {
  objectNameSingular: 'regieListMembership',
  name: 'list',
  label: 'List',
  type: FieldMetadataType.RELATION,
  relation: {
    type: RelationType.MANY_TO_ONE,
    targetObjectNameSingular: 'regieList',
    targetFieldName: 'members',
    targetFieldLabel: 'Members',
    targetFieldIcon: 'IconList',
    onDelete: RelationOnDeleteAction.CASCADE,
  },
};

const expectSchemaApplyError = (
  run: () => unknown,
  code: SchemaApplyExceptionCode,
  message: RegExp,
) => {
  let caught: unknown;

  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(SchemaApplyException);
  expect((caught as SchemaApplyException).code).toBe(code);
  expect((caught as SchemaApplyException).message).toMatch(message);
};

describe('computeSchemaApplyPlan', () => {
  it('should create only the objects that do not exist yet', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        objects: [
          {
            nameSingular: 'person',
            namePlural: 'people',
            labelSingular: 'Person',
            labelPlural: 'People',
          },
          REGIE_LIST_OBJECT,
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(
      plan.objects.map(({ input, isMissing }) => [
        input.nameSingular,
        isMissing,
      ]),
    ).toEqual([
      ['person', false],
      ['regieList', true],
    ]);
  });

  it('should create fields and a relation targeting an object created by the same request', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        objects: [REGIE_LIST_OBJECT, REGIE_LIST_MEMBERSHIP_OBJECT],
        fields: [
          {
            objectNameSingular: 'regieList',
            name: 'name',
            label: 'Name',
            type: FieldMetadataType.TEXT,
          },
          {
            objectNameSingular: 'regieListMembership',
            name: 'membershipKey',
            label: 'Membership Key',
            type: FieldMetadataType.TEXT,
          },
          LIST_RELATION_FIELD,
          {
            objectNameSingular: 'person',
            name: 'externalId',
            label: 'External Id',
            type: FieldMetadataType.TEXT,
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(
      plan.fields.map(({ input, isMissing }) => [
        `${input.objectNameSingular}.${input.name}`,
        isMissing,
      ]),
    ).toEqual([
      // A created custom object already gets its own TEXT name field.
      ['regieList.name', false],
      ['regieListMembership.membershipKey', true],
      ['regieListMembership.list', true],
      ['person.externalId', false],
    ]);
    expect(hasSchemaApplyPlanChanges(plan)).toBe(true);
  });

  it('should reject a field that exists with another type, naming the field', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            fields: [
              {
                objectNameSingular: 'person',
                name: 'externalId',
                label: 'External Id',
                type: FieldMetadataType.NUMBER,
              },
            ],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.SCHEMA_CONFLICT,
      /person\.externalId already exists with type TEXT, requested NUMBER/,
    );
  });

  it('should reject a field on an object that neither exists nor is created', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: { fields: [LIST_RELATION_FIELD] },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.OBJECT_NOT_FOUND,
      /regieListMembership/,
    );
  });

  it('should reject a relation whose inverse field name is already taken', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            objects: [REGIE_LIST_MEMBERSHIP_OBJECT],
            fields: [
              {
                ...LIST_RELATION_FIELD,
                relation: {
                  ...LIST_RELATION_FIELD.relation!,
                  targetObjectNameSingular: 'person',
                  targetFieldName: 'emails',
                },
              },
            ],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.SCHEMA_CONFLICT,
      /inverse field person\.emails already exists/,
    );
  });

  it('should skip an index with the same shape and uniqueness', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        indexes: [
          {
            objectNameSingular: 'person',
            fieldNames: ['externalId'],
            isUnique: true,
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(plan.indexes).toEqual([
      {
        input: {
          objectNameSingular: 'person',
          fieldNames: ['externalId'],
          isUnique: true,
          indexType: IndexType.BTREE,
        },
        isMissing: false,
      },
    ]);
    expect(hasSchemaApplyPlanChanges(plan)).toBe(false);
  });

  it('should reject an index whose shape exists with another uniqueness', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            indexes: [
              {
                objectNameSingular: 'person',
                fieldNames: ['externalId'],
                isUnique: false,
              },
            ],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.SCHEMA_CONFLICT,
      /isUnique=true, requested isUnique=false/,
    );
  });

  it('should plan indexes on fields created by the same request and reuse the relation join-column index', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        objects: [REGIE_LIST_OBJECT, REGIE_LIST_MEMBERSHIP_OBJECT],
        fields: [
          {
            objectNameSingular: 'regieListMembership',
            name: 'membershipKey',
            label: 'Membership Key',
            type: FieldMetadataType.TEXT,
          },
          LIST_RELATION_FIELD,
        ],
        indexes: [
          {
            objectNameSingular: 'regieListMembership',
            fieldNames: ['membershipKey'],
            isUnique: true,
          },
          {
            objectNameSingular: 'regieListMembership',
            fieldNames: ['list'],
            isUnique: false,
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(plan.indexes.map(({ isMissing }) => isMissing)).toEqual([
      true,
      false,
    ]);
  });

  it('should reject an index on a field that does not exist', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            indexes: [
              {
                objectNameSingular: 'person',
                fieldNames: ['unknownField'],
                isUnique: false,
              },
            ],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.FIELD_NOT_FOUND,
      /person\.unknownField/,
    );
  });

  it('should match views by object and case-insensitive name, including the index view of a created object', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        objects: [REGIE_LIST_OBJECT],
        views: [
          {
            objectNameSingular: 'person',
            name: 'all people',
            icon: 'IconUser',
            type: ViewType.TABLE,
          },
          {
            objectNameSingular: 'regieList',
            name: 'All Regie Lists',
            icon: 'IconList',
            type: ViewType.TABLE,
          },
          {
            objectNameSingular: 'regieList',
            name: 'Active Lists',
            icon: 'IconList',
            type: ViewType.TABLE,
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(plan.views.map(({ isMissing }) => isMissing)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('should report no settings change when stored nested values only differ in key order', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        fieldSettings: [
          {
            objectNameSingular: 'person',
            name: 'emails',
            settings: {
              marker: { searchable: true, version: 1, target: 'person' },
            },
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(plan.fieldSettings).toEqual([
      expect.objectContaining({
        fieldId: 'person-emails-id',
        isChanged: false,
      }),
    ]);
    expect(hasSchemaApplyPlanChanges(plan)).toBe(false);
  });

  it('should merge new settings keys shallowly over the current settings', () => {
    const plan = computeSchemaApplyPlan({
      schema: {
        fieldSettings: [
          {
            objectNameSingular: 'person',
            name: 'emails',
            settings: { marker: { version: 2 } },
          },
        ],
      },
      snapshot: SNAPSHOT,
    });

    expect(plan.fieldSettings).toEqual([
      expect.objectContaining({
        isChanged: true,
        mergedSettings: { maxNumberOfValues: 5, marker: { version: 2 } },
      }),
    ]);
  });

  it('should reject settings for a field that does not exist', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            fieldSettings: [
              {
                objectNameSingular: 'person',
                name: 'unknownField',
                settings: { anything: true },
              },
            ],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.FIELD_NOT_FOUND,
      /person\.unknownField/,
    );
  });

  it('should reject the same field requested twice', () => {
    const field: ApplySchemaFieldInput = {
      objectNameSingular: 'person',
      name: 'nickname',
      label: 'Nickname',
      type: FieldMetadataType.TEXT,
    };

    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: { fields: [field, field] },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
      /person\.nickname appears more than once/,
    );
  });

  it('should reject a RELATION field without a relation definition', () => {
    expectSchemaApplyError(
      () =>
        computeSchemaApplyPlan({
          schema: {
            objects: [REGIE_LIST_MEMBERSHIP_OBJECT],
            fields: [{ ...LIST_RELATION_FIELD, relation: undefined }],
          },
          snapshot: SNAPSHOT,
        }),
      SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT,
      /requires a relation definition/,
    );
  });

  it('should have no changes for an empty request', () => {
    expect(
      hasSchemaApplyPlanChanges(
        computeSchemaApplyPlan({ schema: {}, snapshot: SNAPSHOT }),
      ),
    ).toBe(false);
  });
});
