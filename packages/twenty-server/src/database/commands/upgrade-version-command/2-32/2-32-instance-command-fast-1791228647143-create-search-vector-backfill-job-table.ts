import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

@RegisteredInstanceCommand('2.32.0', 1791228647143)
export class CreateSearchVectorBackfillJobTableFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "core"."searchVectorBackfillJob" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workspaceId" uuid NOT NULL,
        "objectMetadataId" uuid NOT NULL,
        "reason" text NOT NULL,
        "filter" jsonb,
        "cutoffAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cursor" uuid,
        "status" text NOT NULL DEFAULT 'PENDING',
        "generation" integer NOT NULL DEFAULT 0,
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        "lastError" text,
        "processedRowCount" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_640229ddaacaaa7079596244057" PRIMARY KEY ("id"),
        CONSTRAINT "FK_b0154b884ac251689ef982cb381" FOREIGN KEY ("workspaceId")
          REFERENCES "core"."workspace"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_c036b37042235e1a34f819d2a3e" FOREIGN KEY ("objectMetadataId")
          REFERENCES "core"."objectMetadata"("id") ON DELETE CASCADE
      )`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_SEARCH_VECTOR_BACKFILL_JOB_ACTIVE_OBJECT_UNIQUE"
        ON "core"."searchVectorBackfillJob" ("workspaceId", "objectMetadataId")
        WHERE "status" IN ('PENDING', 'RUNNING', 'RETRYABLE')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SEARCH_VECTOR_BACKFILL_JOB_STATUS_COMPLETED_AT"
        ON "core"."searchVectorBackfillJob" ("status", "completedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "core"."searchVectorBackfillJob"`,
    );
  }
}
