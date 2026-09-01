import { QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

@RegisteredInstanceCommand('2.32.0', 1786800000000)
export class AddPhoneSearchTokensFastInstanceCommand implements FastInstanceCommand {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "core"."searchFieldMetadata" DROP CONSTRAINT IF EXISTS "IDX_SEARCH_FIELD_METADATA_OBJECT_FIELD_UNIQUE"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."searchFieldMetadata" ADD CONSTRAINT "IDX_SEARCH_FIELD_METADATA_OBJECT_FIELD_UNIQUE" UNIQUE ("objectMetadataId", "fieldMetadataId", "tsVectorFieldMetadataId")',
    );
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.phone_search_tokens(
        field_key text,
        primary_calling_code text,
        primary_number text,
        additional_phones jsonb
      ) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT NULLIF(concat_ws(' ',
          CASE WHEN primary_calling_code ~ '^\\+[0-9]+$' AND primary_number ~ '^[0-9]+$'
            THEN 'f' || replace(field_key, '-', '') || 'p' || substr(primary_calling_code, 2) || primary_number END,
          (SELECT string_agg('f' || replace(field_key, '-', '') || 'p' || substr((additional_phone.value->>'callingCode'), 2) || (additional_phone.value->>'number'), ' ')
             FROM jsonb_array_elements(CASE jsonb_typeof(additional_phones)
               WHEN 'array' THEN additional_phones
               ELSE '[]'::jsonb
             END) AS additional_phone(value)
            WHERE (additional_phone.value->>'callingCode') ~ '^\\+[0-9]+$' AND (additional_phone.value->>'number') ~ '^[0-9]+$')
        ), '')
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP FUNCTION IF EXISTS public.phone_search_tokens(text, text, text, jsonb)',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."searchFieldMetadata" DROP CONSTRAINT IF EXISTS "IDX_SEARCH_FIELD_METADATA_OBJECT_FIELD_UNIQUE"',
    );
    await queryRunner.query(
      'ALTER TABLE "core"."searchFieldMetadata" ADD CONSTRAINT "IDX_SEARCH_FIELD_METADATA_OBJECT_FIELD_UNIQUE" UNIQUE ("objectMetadataId", "fieldMetadataId")',
    );
  }
}
