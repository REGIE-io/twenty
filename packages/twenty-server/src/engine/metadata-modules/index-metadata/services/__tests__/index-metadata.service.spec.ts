import { MAX_CUSTOM_INDEXES_PER_OBJECT } from 'twenty-shared/constants';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { v4 as uuid } from 'uuid';

import { IndexMetadataExceptionCode } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';
import { IndexMetadataService } from 'src/engine/metadata-modules/index-metadata/services/index-metadata.service';
import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';

const SCALAR_FIELD_TYPES: FieldMetadataType[] = [
  FieldMetadataType.TEXT,
  FieldMetadataType.NUMBER,
  FieldMetadataType.BOOLEAN,
  FieldMetadataType.DATE_TIME,
];

const buildService = () => {
  const { allFlatEntityMaps } =
    computeTwentyStandardApplicationAllFlatEntityMaps({
      workspaceId: uuid(),
      now: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      twentyStandardApplicationId: uuid(),
    });
  const { flatObjectMetadataMaps, flatFieldMetadataMaps, flatIndexMaps } =
    allFlatEntityMaps;
  const migrations: { universalIdentifier: string }[][] = [];

  const service = new IndexMetadataService(
    {
      getOrRecomputeManyOrAllFlatEntityMaps: async () => ({
        flatObjectMetadataMaps,
        flatFieldMetadataMaps,
        flatIndexMaps,
      }),
    } as never,
    {
      validateBuildAndRunWorkspaceMigration: async ({
        allFlatEntityOperationByMetadataName,
      }: {
        allFlatEntityOperationByMetadataName: {
          index: { flatEntityToCreate: { universalIdentifier: string }[] };
        };
      }) => {
        const created =
          allFlatEntityOperationByMetadataName.index.flatEntityToCreate;

        migrations.push(created);
        created.forEach((index) => {
          flatIndexMaps.byUniversalIdentifier[index.universalIdentifier] =
            index as never;
        });

        return { status: 'success' };
      },
    } as never,
    {
      findWorkspaceTwentyStandardAndCustomApplicationOrThrow: async () => ({
        workspaceCustomFlatApplication: { universalIdentifier: uuid() },
      }),
    } as never,
  );

  const objectNamed = (nameSingular: string) => {
    const object = Object.values(flatObjectMetadataMaps.byUniversalIdentifier)
      .filter(isDefined)
      .find((candidate) => candidate.nameSingular === nameSingular);

    if (!isDefined(object)) {
      throw new Error(`Standard object ${nameSingular} not found`);
    }

    return object;
  };

  const scalarFieldsOf = (objectMetadataId: string) =>
    Object.values(flatFieldMetadataMaps.byUniversalIdentifier)
      .filter(isDefined)
      .filter(
        (field) =>
          field.objectMetadataId === objectMetadataId &&
          SCALAR_FIELD_TYPES.includes(field.type),
      );

  const btreeIndexOn = (objectMetadataId: string, fieldMetadataId: string) => ({
    objectMetadataId,
    fields: [{ fieldMetadataId }],
    indexType: IndexType.BTREE,
  });

  return {
    service,
    migrations,
    flatIndexMaps,
    objectNamed,
    scalarFieldsOf,
    btreeIndexOn,
  };
};

const workspaceId = uuid();

describe('IndexMetadataService.createMany', () => {
  it('creates every index in one workspace migration, in request order', async () => {
    const { service, migrations, objectNamed, scalarFieldsOf, btreeIndexOn } =
      buildService();
    const inputs = ['company', 'person', 'task'].map((nameSingular) => {
      const object = objectNamed(nameSingular);

      return btreeIndexOn(object.id, scalarFieldsOf(object.id)[0].id);
    });

    const created = await service.createMany({
      createIndexInputs: inputs,
      workspaceId,
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toHaveLength(3);
    expect(created.map((index) => index.universalIdentifier)).toEqual(
      migrations[0].map((index) => index.universalIdentifier),
    );
  });

  it('runs createOne as a batch of one', async () => {
    const { service, migrations, objectNamed, scalarFieldsOf, btreeIndexOn } =
      buildService();
    const company = objectNamed('company');

    await service.createOne({
      createIndexInput: btreeIndexOn(
        company.id,
        scalarFieldsOf(company.id)[0].id,
      ),
      workspaceId,
    });

    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toHaveLength(1);
  });

  it('counts indexes earlier in the same batch toward the per-object limit', async () => {
    const {
      service,
      migrations,
      flatIndexMaps,
      objectNamed,
      scalarFieldsOf,
      btreeIndexOn,
    } = buildService();
    const company = objectNamed('company');
    const [firstField, secondField] = scalarFieldsOf(company.id);

    Array.from({ length: MAX_CUSTOM_INDEXES_PER_OBJECT - 1 }).forEach(() => {
      const universalIdentifier = uuid();

      flatIndexMaps.byUniversalIdentifier[universalIdentifier] = {
        universalIdentifier,
        objectMetadataId: company.id,
        isCustom: true,
      } as never;
    });

    await expect(
      service.createMany({
        createIndexInputs: [
          btreeIndexOn(company.id, firstField.id),
          btreeIndexOn(company.id, secondField.id),
        ],
        workspaceId,
      }),
    ).rejects.toMatchObject({
      code: IndexMetadataExceptionCode.CUSTOM_INDEX_LIMIT_REACHED,
    });
    expect(migrations).toHaveLength(0);
  });

  it('rejects the same index twice in one batch before running any migration', async () => {
    const { service, migrations, objectNamed, scalarFieldsOf, btreeIndexOn } =
      buildService();
    const company = objectNamed('company');
    const input = btreeIndexOn(company.id, scalarFieldsOf(company.id)[0].id);

    await expect(
      service.createMany({ createIndexInputs: [input, input], workspaceId }),
    ).rejects.toMatchObject({
      code: IndexMetadataExceptionCode.DUPLICATE_INDEX_FIELDS,
    });
    expect(migrations).toHaveLength(0);
  });
});
