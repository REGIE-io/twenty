import crypto from 'crypto';

import { DataSource } from 'typeorm';

import { AddPhoneSearchLookupFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1786800000000-add-phone-search-lookup';
import { PhoneSearchFieldLifecycleService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle.service';
import { PhoneSearchIndexBackfillService } from 'src/engine/core-modules/phone-search-index/services/phone-search-index-backfill.service';
import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';
import { PhoneSearchTriggerManagerService } from 'src/engine/core-modules/phone-search-index/services/phone-search-trigger-manager.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

jest.useRealTimers();

const id = () => crypto.randomUUID();

describe('person phone lookup PostgreSQL contracts', () => {
  let dataSource: DataSource;
  let workspaceId: string;
  let objectMetadataId: string;
  let standardFieldId: string;
  let customFieldId: string;
  let schema: string;
  let backfill: PhoneSearchIndexBackfillService;
  const queuedOperationIds: string[] = [];

  const lookupRows = async () =>
    dataSource.query(
      `SELECT "fieldMetadataId", "recordId", "projectionGeneration", "canonicalPhone"
         FROM core."personPhoneLookup"
        WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
        ORDER BY "recordId", "fieldMetadataId", "projectionGeneration", "canonicalPhone"`,
      [workspaceId, objectMetadataId],
    );

  const addState = async ({
    fieldMetadataId,
    physicalFieldName,
    active = 1,
    building = null,
  }: {
    fieldMetadataId: string;
    physicalFieldName: string;
    active?: number | null;
    building?: number | null;
  }) =>
    dataSource.query(
      `INSERT INTO core."phoneSearchFieldState"
        ("workspaceId", "objectMetadataId", "fieldMetadataId", "fieldUniversalIdentifier",
         "physicalFieldName", "syncStatus", "isQueryEnabled",
         "activeProjectionGeneration", "buildingProjectionGeneration")
       VALUES ($1, $2, $3, $4, $5, 'READY', true, $6, $7)`,
      [
        workspaceId,
        objectMetadataId,
        fieldMetadataId,
        id(),
        physicalFieldName,
        active,
        building,
      ],
    );

  const createBackfillOperation = async (generation: number) => {
    const operationId = id();

    await dataSource.query(
      `INSERT INTO core."phoneSearchIndexOperation"
        (id, "workspaceId", "objectMetadataId", kind, status, generation, "fieldMetadataIds")
       VALUES ($1, $2, $3, 'REPAIR', 'PENDING', $4, $5::jsonb)`,
      [
        operationId,
        workspaceId,
        objectMetadataId,
        generation,
        JSON.stringify([standardFieldId, customFieldId]),
      ],
    );

    return operationId;
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await new AddPhoneSearchLookupFastInstanceCommand().up(runner);
    } finally {
      await runner.release();
    }

    const queue = {
      add: jest.fn(async (_name: string, data: { operationId: string }) => {
        queuedOperationIds.push(data.operationId);
      }),
    };
    backfill = new PhoneSearchIndexBackfillService(dataSource, queue as never);
  });

  beforeEach(async () => {
    queuedOperationIds.length = 0;
    workspaceId = id();
    objectMetadataId = id();
    standardFieldId = id();
    customFieldId = id();
    schema = getWorkspaceSchemaName(workspaceId);
    await dataSource.query(`CREATE SCHEMA "${schema}"`);
    await dataSource.query(`
      CREATE TABLE "${schema}".person (
        id uuid PRIMARY KEY,
        "phonesPrimaryPhoneCallingCode" text,
        "phonesPrimaryPhoneNumber" text,
        "phonesAdditionalPhones" jsonb,
        "workPhonePrimaryPhoneCallingCode" text,
        "workPhonePrimaryPhoneNumber" text,
        "workPhoneAdditionalPhones" jsonb,
        note text
      )
    `);
    await addState({
      fieldMetadataId: standardFieldId,
      physicalFieldName: 'phones',
    });
    await addState({
      fieldMetadataId: customFieldId,
      physicalFieldName: 'workPhone',
    });
    await new PhoneSearchTriggerManagerService(dataSource).install({
      workspaceId,
      objectMetadataId,
    });
  });

  afterEach(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await dataSource.query(
      'DELETE FROM core."phoneSearchIndexOperation" WHERE "workspaceId" = $1',
      [workspaceId],
    );
    await dataSource.query(
      'DELETE FROM core."phoneSearchFieldState" WHERE "workspaceId" = $1',
      [workspaceId],
    );
    await dataSource.query(
      'DELETE FROM core."personPhoneLookup" WHERE "workspaceId" = $1',
      [workspaceId],
    );
  });

  afterAll(async () => dataSource.destroy());

  it('extracts standard and custom primary/additional values and maintains them transactionally', async () => {
    const recordId = id();
    await dataSource.query(
      `INSERT INTO "${schema}".person VALUES
       ($1, '+1', '4155551000', $2::jsonb, '+44', '2071838750', $3::jsonb, '14155551000')`,
      [
        recordId,
        JSON.stringify([
          { callingCode: '+1', number: '4155551000' },
          { callingCode: '+33', number: '145555501' },
          { callingCode: '+x', number: 'ignored' },
          { callingCode: '+1' },
        ]),
        JSON.stringify([{ callingCode: '+44', number: '2071838751' }]),
      ],
    );
    expect(await lookupRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldMetadataId: standardFieldId,
          recordId,
          projectionGeneration: '1',
          canonicalPhone: '14155551000',
        }),
        expect.objectContaining({
          fieldMetadataId: standardFieldId,
          recordId,
          projectionGeneration: '1',
          canonicalPhone: '33145555501',
        }),
        expect.objectContaining({
          fieldMetadataId: customFieldId,
          recordId,
          projectionGeneration: '1',
          canonicalPhone: '442071838750',
        }),
        expect.objectContaining({
          fieldMetadataId: customFieldId,
          recordId,
          projectionGeneration: '1',
          canonicalPhone: '442071838751',
        }),
      ]),
    );
    const beforeUnrelatedUpdate = await lookupRows();
    await dataSource.query(
      `UPDATE "${schema}".person SET note = 'unrelated' WHERE id = $1`,
      [recordId],
    );
    expect(await lookupRows()).toEqual(beforeUnrelatedUpdate);

    await dataSource
      .transaction(async (manager) => {
        await manager.query(
          `UPDATE "${schema}".person SET "phonesPrimaryPhoneNumber" = '4155551002' WHERE id = $1`,
          [recordId],
        );
        const uncommittedRows = await manager.query(
          `SELECT "canonicalPhone" FROM core."personPhoneLookup"
          WHERE "workspaceId" = $1 AND "recordId" = $2`,
          [workspaceId, recordId],
        );
        expect(uncommittedRows).toEqual(
          expect.arrayContaining([{ canonicalPhone: '14155551002' }]),
        );
        throw new Error('roll back phone update');
      })
      .catch((error) => expect(error.message).toBe('roll back phone update'));
    expect(
      (await lookupRows()).some(
        (row: { canonicalPhone: string }) =>
          row.canonicalPhone === '14155551002',
      ),
    ).toBe(false);

    await dataSource.query(`DELETE FROM "${schema}".person WHERE id = $1`, [
      recordId,
    ]);
    expect(await lookupRows()).toEqual([]);
  });

  it('keeps both generations correct across a multi-batch repair and atomically purges the retired generation', async () => {
    await dataSource.query(
      `UPDATE core."phoneSearchFieldState"
          SET "buildingProjectionGeneration" = 2, "syncStatus" = 'INDEXING'
        WHERE "workspaceId" = $1`,
      [workspaceId],
    );
    const recordIds: string[] = [];
    for (let index = 0; index < 251; index++) recordIds.push(id());
    recordIds.sort();
    for (const [index, recordId] of recordIds.entries())
      await dataSource.query(
        `INSERT INTO "${schema}".person
          (id, "phonesPrimaryPhoneCallingCode", "phonesPrimaryPhoneNumber")
         VALUES ($1, '+1', $2)`,
        [recordId, `41555${String(51000 + index).padStart(5, '0')}`],
      );
    const operationId = await createBackfillOperation(2);
    expect(await backfill.runBatch(operationId)).toBe(false);

    const changedId = recordIds[0];
    await dataSource.query(
      `UPDATE "${schema}".person SET "phonesPrimaryPhoneNumber" = '4155559999' WHERE id = $1`,
      [changedId],
    );
    const bothGenerations = await dataSource.query(
      `SELECT "projectionGeneration", "canonicalPhone" FROM core."personPhoneLookup"
        WHERE "workspaceId" = $1 AND "recordId" = $2 ORDER BY "projectionGeneration"`,
      [workspaceId, changedId],
    );
    expect(bothGenerations).toEqual([
      { projectionGeneration: '1', canonicalPhone: '14155559999' },
      { projectionGeneration: '2', canonicalPhone: '14155559999' },
    ]);
    expect(await backfill.runBatch(operationId)).toBe(true);

    const [state] = await dataSource.query(
      `SELECT "activeProjectionGeneration", "buildingProjectionGeneration", "syncStatus"
         FROM core."phoneSearchFieldState" WHERE "workspaceId" = $1 AND "fieldMetadataId" = $2`,
      [workspaceId, standardFieldId],
    );
    expect(state).toEqual({
      activeProjectionGeneration: '2',
      buildingProjectionGeneration: null,
      syncStatus: 'READY',
    });
    expect(queuedOperationIds).toHaveLength(1);
    const currentRows = await dataSource.query(
      `SELECT "canonicalPhone" FROM core."personPhoneLookup"
        WHERE "workspaceId" = $1 AND "recordId" = $2 AND "projectionGeneration" = 2`,
      [workspaceId, changedId],
    );
    expect(currentRows).toEqual([{ canonicalPhone: '14155559999' }]);
    while (!(await backfill.runBatch(queuedOperationIds[0]))) {
      // The production purge uses bounded ID batches, so a large tenant may
      // require more than one delivery before retired rows disappear.
    }
    const purgeState = await dataSource.query(
      'SELECT id, status, "leaseExpiresAt" FROM core."phoneSearchIndexOperation" WHERE id = $1',
      [queuedOperationIds[0]],
    );
    if (purgeState[0]?.status !== 'COMPLETED')
      throw new Error(JSON.stringify(purgeState));
    expect(
      await dataSource.query(
        `SELECT "fieldMetadataId", "recordId", "canonicalPhone" FROM core."personPhoneLookup" WHERE "workspaceId" = $1 AND "projectionGeneration" = 1`,
        [workspaceId],
      ),
    ).toEqual([]);
  });

  it.each(['14155551000', '19999999999'])(
    'uses the production B-tree equality index for a %s lookup without text search',
    async (canonicalPhone) => {
      await dataSource.query(
        `INSERT INTO core."personPhoneLookup"
        (id, "workspaceId", "objectMetadataId", "fieldMetadataId", "recordId", "projectionGeneration", "canonicalPhone")
       SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 2, ('1' || value::text)
         FROM generate_series(1000000000, 1000000299) AS value`,
        [workspaceId, objectMetadataId, standardFieldId],
      );
      await dataSource.query('ANALYZE core."personPhoneLookup"');
      await dataSource.query('SET enable_seqscan = off');
      try {
        const [{ 'QUERY PLAN': plan }] = await dataSource.query(
          `EXPLAIN (FORMAT JSON) SELECT "recordId" FROM core."personPhoneLookup"
          WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
            AND "canonicalPhone" = $3 AND "fieldMetadataId" = $4
            AND "projectionGeneration" = 2`,
          [workspaceId, objectMetadataId, canonicalPhone, standardFieldId],
        );
        const rendered = JSON.stringify(plan);
        expect(rendered).toMatch(/Index(?: Only)? Scan|Bitmap Index Scan/);
        expect(rendered).toMatch(
          /workspaceId.*objectMetadataId.*canonicalPhone/,
        );
        expect(rendered).not.toMatch(/LIKE|ILIKE|to_tsquery/i);
      } finally {
        await dataSource.query('RESET enable_seqscan');
      }
    },
  );

  it('executes the production metadata lock and purges only retired per-field generations', async () => {
    await dataSource.transaction((manager) =>
      new PhoneSearchMetadataGateService(dataSource).assertAvailable({
        workspaceId,
        objectMetadataId,
        manager,
      }),
    );

    await dataSource.query(
      `UPDATE core."phoneSearchFieldState"
          SET "activeProjectionGeneration" = 2
        WHERE "workspaceId" = $1 AND "fieldMetadataId" = $2`,
      [workspaceId, customFieldId],
    );
    const standardRecordId = id();
    const customRecordId = id();
    await dataSource.query(
      `INSERT INTO core."personPhoneLookup"
        ("workspaceId", "objectMetadataId", "fieldMetadataId", "recordId", "projectionGeneration", "canonicalPhone")
       VALUES
        ($1, $2, $3, $4, 1, '14155550001'),
        ($1, $2, $5, $6, 1, '14155550002'),
        ($1, $2, $5, $6, 2, '14155550002')`,
      [
        workspaceId,
        objectMetadataId,
        standardFieldId,
        standardRecordId,
        customFieldId,
        customRecordId,
      ],
    );
    const purgeOperationId = id();
    await dataSource.query(
      `INSERT INTO core."phoneSearchIndexOperation"
        (id, "workspaceId", "objectMetadataId", kind, status, generation, "fieldMetadataIds")
       VALUES ($1, $2, $3, 'PURGE_GENERATION', 'PENDING', 2, $4::jsonb)`,
      [
        purgeOperationId,
        workspaceId,
        objectMetadataId,
        JSON.stringify([customFieldId]),
      ],
    );

    expect(await backfill.runBatch(purgeOperationId)).toBe(true);
    expect(
      await dataSource.query(
        `SELECT "fieldMetadataId", "projectionGeneration"
           FROM core."personPhoneLookup"
          WHERE "workspaceId" = $1 AND "recordId" = ANY($2::uuid[])
          ORDER BY "fieldMetadataId", "projectionGeneration"`,
        [workspaceId, [standardRecordId, customRecordId]],
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          fieldMetadataId: standardFieldId,
          projectionGeneration: '1',
        },
        { fieldMetadataId: customFieldId, projectionGeneration: '2' },
      ]),
    );
    expect(
      await dataSource.query(
        `SELECT 1 FROM core."personPhoneLookup"
          WHERE "workspaceId" = $1 AND "fieldMetadataId" = $2
            AND "projectionGeneration" = 1`,
        [workspaceId, customFieldId],
      ),
    ).toEqual([]);
  });

  it('coalesces multiple fields created in one metadata transaction', async () => {
    const lifecycle = new PhoneSearchFieldLifecycleService(dataSource);
    const firstFieldId = id();
    const secondFieldId = id();
    const operationIds = await dataSource.transaction(async (manager) => [
      await lifecycle.create({
        workspaceId,
        objectMetadataId,
        fieldMetadataId: firstFieldId,
        fieldUniversalIdentifier: id(),
        physicalFieldName: 'firstCustomPhone',
        isActive: true,
        manager,
      }),
      await lifecycle.create({
        workspaceId,
        objectMetadataId,
        fieldMetadataId: secondFieldId,
        fieldUniversalIdentifier: id(),
        physicalFieldName: 'secondCustomPhone',
        isActive: true,
        manager,
      }),
    ]);

    expect(operationIds[0]).toBeDefined();
    expect(operationIds[1]).toBe(operationIds[0]);
    const [operation] = await dataSource.query(
      `SELECT generation, "fieldMetadataIds"
         FROM core."phoneSearchIndexOperation"
        WHERE id = $1`,
      [operationIds[0]],
    );
    expect(operation.fieldMetadataIds).toEqual([firstFieldId, secondFieldId]);
    expect(
      await dataSource.query(
        `SELECT DISTINCT "buildingProjectionGeneration"
           FROM core."phoneSearchFieldState"
          WHERE "workspaceId" = $1 AND "fieldMetadataId" = ANY($2::uuid[])`,
        [workspaceId, [firstFieldId, secondFieldId]],
      ),
    ).toEqual([{ buildingProjectionGeneration: operation.generation }]);
  });
});
