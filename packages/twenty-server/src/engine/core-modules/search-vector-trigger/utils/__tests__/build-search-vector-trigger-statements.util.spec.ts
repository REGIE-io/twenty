import { buildSearchVectorTriggerStatements } from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';

const expression = `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE((NEW."jobTitle"), ''))), 131072)))`;

describe('buildSearchVectorTriggerStatements', () => {
  it('builds a function and a BEFORE INSERT OR UPDATE trigger in the workspace schema', () => {
    const statements = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: 'person',
      triggerRowExpression: expression,
    });

    expect(statements.functionName).toBe('person_search_vector');
    expect(statements.createFunction).toBe(
      `CREATE OR REPLACE FUNCTION "workspace_abc"."person_search_vector"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $search_vector$
BEGIN
  NEW."searchVector" := ${expression};
  RETURN NEW;
END
$search_vector$`,
    );
    expect(statements.createTrigger).toBe(
      `CREATE TRIGGER "person_search_vector" BEFORE INSERT OR UPDATE ON "workspace_abc"."person" FOR EACH ROW EXECUTE FUNCTION "workspace_abc"."person_search_vector"()`,
    );
    expect(statements.dropTrigger).toBe(
      `DROP TRIGGER IF EXISTS "person_search_vector" ON "workspace_abc"."person"`,
    );
  });

  it('keeps names within Postgres 63-byte identifiers for long custom tables', () => {
    const { functionName } = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: `_${'a'.repeat(62)}`,
      triggerRowExpression: expression,
    });

    expect(functionName.length).toBeLessThanOrEqual(63);
    expect(functionName).toMatch(/_search_vector_[0-9a-f]{8}$/);
  });

  it('counts bytes, not characters, when truncating a multibyte table name', () => {
    const { functionName } = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: `_${'é'.repeat(40)}`,
      triggerRowExpression: expression,
    });

    expect(Buffer.byteLength(functionName, 'utf8')).toBeLessThanOrEqual(63);
    expect(functionName).not.toContain('\uFFFD');
    expect(functionName).toMatch(/^_é+_search_vector_[0-9a-f]{8}$/);
  });

  it('gives different names to long tables that share a prefix', () => {
    const first = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: `_${'a'.repeat(60)}x`,
      triggerRowExpression: expression,
    }).functionName;
    const second = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: `_${'a'.repeat(60)}y`,
      triggerRowExpression: expression,
    }).functionName;

    expect(first).not.toBe(second);
  });

  it('refuses an unsafe expression', () => {
    expect(() =>
      buildSearchVectorTriggerStatements({
        schemaName: 'workspace_abc',
        tableName: 'person',
        triggerRowExpression: 'x; DROP TABLE y; $$',
      }),
    ).toThrow('Unsafe tsvector expression detected');
  });

  it('doubles double quotes in schema and table names', () => {
    const statements = buildSearchVectorTriggerStatements({
      schemaName: 'we"ird',
      tableName: 'we"ird',
      triggerRowExpression: expression,
    });

    expect(statements.createTrigger).toContain('ON "we""ird"."we""ird"');
    expect(statements.dropTrigger).toContain('ON "we""ird"."we""ird"');
  });

  it('refuses a null byte in the table name', () => {
    expect(() =>
      buildSearchVectorTriggerStatements({
        schemaName: 'workspace_abc',
        tableName: 'per\0son',
        triggerRowExpression: expression,
      }),
    ).toThrow();
  });
});
