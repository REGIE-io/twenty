import { QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

// This is deliberately an instance-only, fixed schema migration.  Workspace
// upgrades merely install a stable trigger and create state rows; they never
// alter the (potentially very large) Person relation.
@RegisteredInstanceCommand('2.32.0', 1786800000000)
export class AddPhoneSearchLookupFastInstanceCommand implements FastInstanceCommand {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS core."personPhoneLookup" (
        id uuid NOT NULL DEFAULT gen_random_uuid(), "workspaceId" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL, "fieldMetadataId" uuid NOT NULL,
        "recordId" uuid NOT NULL, "projectionGeneration" bigint NOT NULL,
        "canonicalPhone" varchar(32) NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("workspaceId", id),
        UNIQUE ("workspaceId", "objectMetadataId", "fieldMetadataId", "projectionGeneration", "recordId", "canonicalPhone")
      ) PARTITION BY HASH ("workspaceId");
    `);
    for (let partition = 0; partition < 32; partition++) {
      await queryRunner.query(
        `CREATE TABLE IF NOT EXISTS core."personPhoneLookup_p${partition}" PARTITION OF core."personPhoneLookup" FOR VALUES WITH (MODULUS 32, REMAINDER ${partition})`,
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PERSON_PHONE_LOOKUP_LOOKUP" ON core."personPhoneLookup" ("workspaceId", "objectMetadataId", "canonicalPhone", "fieldMetadataId", "projectionGeneration", "recordId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PERSON_PHONE_LOOKUP_RECORD" ON core."personPhoneLookup" ("workspaceId", "objectMetadataId", "recordId", "projectionGeneration")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_PERSON_PHONE_LOOKUP_FIELD" ON core."personPhoneLookup" ("workspaceId", "objectMetadataId", "fieldMetadataId", "projectionGeneration")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS core."phoneSearchFieldState" (
        "workspaceId" uuid NOT NULL, "objectMetadataId" uuid NOT NULL, "fieldMetadataId" uuid NOT NULL,
        "fieldUniversalIdentifier" uuid NOT NULL, "physicalFieldName" varchar NOT NULL,
        "syncStatus" varchar NOT NULL CHECK ("syncStatus" IN ('INDEXING','READY','FAILED','DELETING')),
        "isQueryEnabled" boolean NOT NULL DEFAULT false, "configurationGeneration" bigint NOT NULL DEFAULT 1,
        "activeProjectionGeneration" bigint, "buildingProjectionGeneration" bigint,
        "lastError" text, "lastErrorAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("workspaceId", "objectMetadataId", "fieldMetadataId"),
        CONSTRAINT "FK_PHONE_SEARCH_FIELD_STATE_WORKSPACE" FOREIGN KEY ("workspaceId") REFERENCES core."workspace"(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_PHONE_SEARCH_FIELD_STATE_QUERY" ON core."phoneSearchFieldState" ("workspaceId", "objectMetadataId", "syncStatus", "isQueryEnabled");
      CREATE TABLE IF NOT EXISTS core."phoneSearchIndexOperation" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" uuid NOT NULL, "objectMetadataId" uuid NOT NULL,
        kind varchar NOT NULL, status varchar NOT NULL, generation bigint NOT NULL, "fieldMetadataIds" jsonb NOT NULL,
        "lastRecordId" uuid, "processedRecordCount" bigint NOT NULL DEFAULT 0, "estimatedRecordCount" bigint,
        "attemptCount" integer NOT NULL DEFAULT 0, "lastError" text, "lastErrorAt" timestamptz,
        "leaseOwner" varchar, "leaseExpiresAt" timestamptz, "heartbeatAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "startedAt" timestamptz, "completedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_PHONE_SEARCH_INDEX_OPERATION_WORKSPACE" FOREIGN KEY ("workspaceId") REFERENCES core."workspace"(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_PHONE_SEARCH_OPERATION_ACTIVE" ON core."phoneSearchIndexOperation" ("workspaceId", "objectMetadataId") WHERE status IN ('PENDING','RUNNING','RETRYABLE');
    `);
    // `CREATE TABLE IF NOT EXISTS` leaves an early/partial installation in
    // place. Add the ownership FKs separately so rerunning this command also
    // upgrades those tables, without failing when a named constraint exists.
    await queryRunner.query(`
      DO $$
      BEGIN
        FOR partition IN 0..31 LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('FK_PERSON_PHONE_LOOKUP_WORKSPACE_P%s', partition) AND conrelid = format('core."personPhoneLookup_p%s"', partition)::regclass) THEN
            EXECUTE format('ALTER TABLE core."personPhoneLookup_p%s" ADD CONSTRAINT "FK_PERSON_PHONE_LOOKUP_WORKSPACE_P%s" FOREIGN KEY ("workspaceId") REFERENCES core."workspace"(id) ON DELETE CASCADE NOT VALID', partition, partition);
          END IF;
        END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_PHONE_SEARCH_FIELD_STATE_WORKSPACE' AND conrelid = 'core."phoneSearchFieldState"'::regclass) THEN
          ALTER TABLE core."phoneSearchFieldState" ADD CONSTRAINT "FK_PHONE_SEARCH_FIELD_STATE_WORKSPACE" FOREIGN KEY ("workspaceId") REFERENCES core."workspace"(id) ON DELETE CASCADE NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_PHONE_SEARCH_INDEX_OPERATION_WORKSPACE' AND conrelid = 'core."phoneSearchIndexOperation"'::regclass) THEN
          ALTER TABLE core."phoneSearchIndexOperation" ADD CONSTRAINT "FK_PHONE_SEARCH_INDEX_OPERATION_WORKSPACE" FOREIGN KEY ("workspaceId") REFERENCES core."workspace"(id) ON DELETE CASCADE NOT VALID;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.phone_search_values(row_value jsonb, physical_field_name text)
      RETURNS TABLE("canonicalPhone" text) LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
        WITH values_to_normalize AS (
          SELECT row_value ->> (physical_field_name || 'PrimaryPhoneCallingCode') AS calling_code,
                 row_value ->> (physical_field_name || 'PrimaryPhoneNumber') AS number
          UNION ALL
          SELECT value ->> 'callingCode', value ->> 'number'
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(row_value -> (physical_field_name || 'AdditionalPhones')) = 'array' THEN row_value -> (physical_field_name || 'AdditionalPhones') ELSE '[]'::jsonb END)
        ) SELECT DISTINCT substr(calling_code, 2) || number FROM values_to_normalize
          WHERE calling_code ~ '^\\+[0-9]+$' AND number ~ '^[0-9]+$';
      $$;
      CREATE OR REPLACE FUNCTION public.sync_person_phone_lookup()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
      DECLARE state record; source_row jsonb; generation bigint; workspace_id uuid := TG_ARGV[0]::uuid; object_id uuid := TG_ARGV[1]::uuid;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          DELETE FROM core."personPhoneLookup" WHERE "workspaceId" = workspace_id AND "objectMetadataId" = object_id AND "recordId" = OLD.id;
          RETURN OLD;
        END IF;
        source_row := to_jsonb(NEW);
        FOR state IN SELECT * FROM core."phoneSearchFieldState" WHERE "workspaceId" = workspace_id AND "objectMetadataId" = object_id AND "syncStatus" <> 'DELETING' LOOP
          IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>(state."physicalFieldName" || 'PrimaryPhoneCallingCode'), to_jsonb(OLD)->>(state."physicalFieldName" || 'PrimaryPhoneNumber'), to_jsonb(OLD)->(state."physicalFieldName" || 'AdditionalPhones')) IS NOT DISTINCT FROM (source_row->>(state."physicalFieldName" || 'PrimaryPhoneCallingCode'), source_row->>(state."physicalFieldName" || 'PrimaryPhoneNumber'), source_row->(state."physicalFieldName" || 'AdditionalPhones')) THEN CONTINUE; END IF;
          FOREACH generation IN ARRAY ARRAY[state."activeProjectionGeneration", state."buildingProjectionGeneration"] LOOP
            IF generation IS NULL THEN CONTINUE; END IF;
            DELETE FROM core."personPhoneLookup" WHERE "workspaceId" = workspace_id AND "objectMetadataId" = object_id AND "fieldMetadataId" = state."fieldMetadataId" AND "recordId" = NEW.id AND "projectionGeneration" = generation;
            INSERT INTO core."personPhoneLookup" ("workspaceId", "objectMetadataId", "fieldMetadataId", "recordId", "projectionGeneration", "canonicalPhone")
            SELECT workspace_id, object_id, state."fieldMetadataId", NEW.id, generation, "canonicalPhone" FROM public.phone_search_values(source_row, state."physicalFieldName")
            ON CONFLICT ("workspaceId", "objectMetadataId", "fieldMetadataId", "projectionGeneration", "recordId", "canonicalPhone") DO NOTHING;
          END LOOP;
        END LOOP;
        RETURN NEW;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ count }] = await queryRunner.query(
      'SELECT count(*)::int AS count FROM core."personPhoneLookup"',
    );
    if (count > 0)
      throw new Error('Refusing to drop non-empty personPhoneLookup');
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS public.sync_person_phone_lookup()',
    );
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS public.phone_search_values(jsonb, text)',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS core."phoneSearchIndexOperation"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS core."phoneSearchFieldState"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS core."personPhoneLookup"');
  }
}
