import crypto from 'crypto';

import { DataSource } from 'typeorm';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';

jest.useRealTimers();

describe('workspace deletion production-shaped PostgreSQL performance contracts', () => {
  let dataSource: DataSource;
  let workspaceIds: string[];

  const insertWorkspace = async (id: string, deletedAt: Date) => {
    workspaceIds.push(id);
    await dataSource.query(
      `INSERT INTO "core"."workspace" (
        id, subdomain, "activationStatus", "workspaceCustomApplicationId",
        "defaultRoleId", "databaseSchema", "deletedAt"
      )
      SELECT $1, $2, 'SUSPENDED', application.id, role.id, $3, $4
      FROM "core"."application" application
      CROSS JOIN "core"."role" role
      LIMIT 1`,
      [
        id,
        `org-e2e-performance-${id}`,
        `workspace_${id.replace(/-/g, '')}`,
        deletedAt,
      ],
    );
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
      ssl:
        process.env.PG_DATABASE_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
    });
    await dataSource.initialize();
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await new AddWorkspaceDeletionLifecycleFastInstanceCommand().up(
        queryRunner,
      );
    } finally {
      await queryRunner.release();
    }
  });

  beforeEach(() => {
    workspaceIds = [];
  });

  afterEach(async () => {
    await dataSource.query(
      `DELETE FROM "core"."workspace" WHERE id = ANY($1::uuid[])`,
      [workspaceIds],
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('deletes 600 paired relation fields in one statement without touching another workspace', async () => {
    const targetId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    await insertWorkspace(targetId, new Date('2026-09-01T00:00:00.000Z'));
    await insertWorkspace(otherId, new Date('2026-09-01T00:00:00.000Z'));
    const [{ id: applicationId }] = await dataSource.query(
      `SELECT id FROM "core"."application" LIMIT 1`,
    );
    const objectIds = [crypto.randomUUID(), crypto.randomUUID()];

    for (const [workspaceId, objectId] of [
      [targetId, objectIds[0]],
      [otherId, objectIds[1]],
    ]) {
      await dataSource.query(
        `INSERT INTO "core"."objectMetadata" (
          id, "nameSingular", "namePlural", "labelSingular", "labelPlural",
          "targetTableName", "workspaceId", "applicationId", "universalIdentifier"
        ) VALUES ($1, $2, $3, $2, $3, $2, $4, $5, $6)`,
        [
          objectId,
          `object_${objectId}`,
          `objects_${objectId}`,
          workspaceId,
          applicationId,
          crypto.randomUUID(),
        ],
      );
    }

    const targetFields = Array.from({ length: 600 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `field_${index}`,
      universalIdentifier: crypto.randomUUID(),
    }));
    const otherFields = Array.from({ length: 10 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `other_field_${index}`,
      universalIdentifier: crypto.randomUUID(),
    }));
    const insertFields = async (
      fields: typeof targetFields,
      workspaceId: string,
      objectId: string,
    ) => {
      await dataSource.query(
        `INSERT INTO "core"."fieldMetadata" (
          id, "objectMetadataId", type, name, label, "workspaceId",
          "universalIdentifier", "applicationId"
        )
        SELECT value.id::uuid, $2, 'TEXT', value.name, value.name, $3,
               value."universalIdentifier"::uuid, $4
        FROM jsonb_to_recordset($1::jsonb)
          AS value(id text, name text, "universalIdentifier" text)`,
        [JSON.stringify(fields), objectId, workspaceId, applicationId],
      );
    };
    await insertFields(targetFields, targetId, objectIds[0]);
    await insertFields(otherFields, otherId, objectIds[1]);

    const relations = targetFields.map((field, index) => ({
      id: field.id,
      targetId:
        index % 2 === 0
          ? targetFields[index + 1].id
          : targetFields[index - 1].id,
    }));

    await dataSource.query(
      `UPDATE "core"."fieldMetadata" field
       SET "relationTargetFieldMetadataId" = relation."targetId"::uuid
       FROM jsonb_to_recordset($1::jsonb) AS relation(id text, "targetId" text)
       WHERE field.id = relation.id::uuid`,
      [JSON.stringify(relations)],
    );

    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();
    const plan = await queryRunner.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       DELETE FROM "core"."fieldMetadata" WHERE "workspaceId" = $1`,
      [targetId],
    );
    const [targetCount] = await queryRunner.query(
      `SELECT count(*)::int count FROM "core"."fieldMetadata" WHERE "workspaceId" = $1`,
      [targetId],
    );
    const [otherCount] = await queryRunner.query(
      `SELECT count(*)::int count FROM "core"."fieldMetadata" WHERE "workspaceId" = $1`,
      [otherId],
    );
    await queryRunner.rollbackTransaction();
    await queryRunner.release();

    expect(targetCount.count).toBe(0);
    expect(otherCount.count).toBe(10);
    expect(plan[0]['QUERY PLAN'][0]['Execution Time']).toEqual(
      expect.any(Number),
    );
    expect(JSON.stringify(plan)).toContain('IDX_FIELD_METADATA_WORKSPACE_ID');
  });

  it('cancels lock contention on the server and rolls back before the statement deadline', async () => {
    const workspaceId = crypto.randomUUID();

    await insertWorkspace(workspaceId, new Date('2026-09-01T00:00:00.000Z'));
    const blocker = dataSource.createQueryRunner();
    const maintenance = dataSource.createQueryRunner();

    await blocker.connect();
    await maintenance.connect();
    await blocker.startTransaction();
    await maintenance.startTransaction();

    try {
      await blocker.query(
        `SELECT id FROM "core"."workspace" WHERE id = $1 FOR UPDATE`,
        [workspaceId],
      );
      await maintenance.query(
        `SELECT set_config('statement_timeout', $1, true)`,
        ['500ms'],
      );
      await maintenance.query(`SELECT set_config('lock_timeout', $1, true)`, [
        '50ms',
      ]);
      const startedAt = Date.now();
      let failure: { code?: string } | undefined;

      try {
        await maintenance.query(
          `UPDATE "core"."workspace" SET "deletionLastErrorCode" = 'SHOULD_ROLL_BACK' WHERE id = $1`,
          [workspaceId],
        );
      } catch (error) {
        failure = error as { code?: string };
      }
      const elapsedMs = Date.now() - startedAt;

      expect(failure?.code).toBe('55P03');
      expect(elapsedMs).toEqual(expect.any(Number));
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      await maintenance.rollbackTransaction();
      await blocker.rollbackTransaction();
      await maintenance.release();
      await blocker.release();
    }

    const [workspace] = await dataSource.query(
      `SELECT "deletionLastErrorCode" FROM "core"."workspace" WHERE id = $1`,
      [workspaceId],
    );

    expect(workspace.deletionLastErrorCode).toBeNull();
  });

  it('returns the oldest 15 safe markers and records an indexed query plan', async () => {
    const oldestFirst: string[] = [];
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();

    const fixtures = Array.from({ length: 120 }, (_, index) => {
      const id = crypto.randomUUID();

      oldestFirst.push(id);
      workspaceIds.push(id);

      return {
        id,
        subdomain: `org-e2e-performance-${id}`,
        databaseSchema: `workspace_${id.replace(/-/g, '')}`,
        deletedAt: new Date(base + index * 1_000).toISOString(),
        organizationId: `org_e2e_performance_${index}`,
      };
    });

    await dataSource.query(
      `WITH defaults AS (
         SELECT application.id "applicationId", role.id "roleId"
         FROM "core"."application" application
         CROSS JOIN "core"."role" role LIMIT 1
       ), fixture AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS value(id text, subdomain text, "databaseSchema" text, "deletedAt" timestamptz, "organizationId" text)
       )
       INSERT INTO "core"."workspace" (
         id, subdomain, "activationStatus", "workspaceCustomApplicationId",
         "defaultRoleId", "databaseSchema", "deletedAt"
       )
       SELECT fixture.id::uuid, fixture.subdomain, 'SUSPENDED', defaults."applicationId",
              defaults."roleId", fixture."databaseSchema", fixture."deletedAt"
       FROM fixture CROSS JOIN defaults`,
      [JSON.stringify(fixtures)],
    );
    await dataSource.query(
      `INSERT INTO "core"."keyValuePair" ("workspaceId", key, value, type)
       SELECT fixture.id::uuid, 'regie-internal:e2e-workspace-marker',
              jsonb_build_object(
                'ephemeral', true,
                'organizationId', fixture."organizationId",
                'workspaceSlug', fixture.subdomain
              ),
              'USER_VARIABLE'
       FROM jsonb_to_recordset($1::jsonb)
         AS fixture(id text, subdomain text, "organizationId" text)`,
      [JSON.stringify(fixtures)],
    );

    const sql = `
      SELECT workspace.id
      FROM "core"."keyValuePair" marker
      JOIN "core"."workspace" workspace ON workspace.id = marker."workspaceId"
      WHERE marker.key = 'regie-internal:e2e-workspace-marker'
        AND marker.type = 'USER_VARIABLE'
        AND marker.value ->> 'ephemeral' = 'true'
        AND marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'
        AND workspace.subdomain LIKE 'org-e2e-%'
        AND workspace."deletedAt" <= $1
      ORDER BY workspace."deletedAt" ASC, workspace.id ASC
      LIMIT 15`;
    const candidates = await dataSource.query<Array<{ id: string }>>(sql, [
      new Date('2026-09-02T00:00:00.000Z'),
    ]);
    const queryRunner = dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.query('SET enable_seqscan TO off');

    let plan;

    try {
      // The fixture is intentionally small, so PostgreSQL may prefer a sequential
      // scan even when the production discovery index is usable. Disable sequential
      // scans only for this explain to assert index eligibility deterministically.
      plan = await queryRunner.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, [
        new Date('2026-09-02T00:00:00.000Z'),
      ]);
    } finally {
      await queryRunner.query('RESET enable_seqscan');
      await queryRunner.release();
    }
    const serializedPlan = JSON.stringify(plan);

    expect(candidates.map(({ id }) => id)).toEqual(oldestFirst.slice(0, 15));
    expect(plan[0]['QUERY PLAN'][0]['Execution Time']).toEqual(
      expect.any(Number),
    );
    expect(serializedPlan).toContain('IDX_REGIE_E2E_MARKER_DISCOVERY');
  });
});
