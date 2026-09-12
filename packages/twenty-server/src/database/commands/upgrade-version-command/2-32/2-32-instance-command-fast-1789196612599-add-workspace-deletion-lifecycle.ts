import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

@RegisteredInstanceCommand('2.32.0', 1789196612599)
export class AddWorkspaceDeletionLifecycleFastInstanceCommand implements FastInstanceCommand {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const status of [
      'PENDING_DELETION',
      'ONGOING_DELETION',
      'DELETION_FAILED',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "core"."workspace_activationStatus_enum" ADD VALUE IF NOT EXISTS '${status}'`,
      );
    }

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "core"."workspace_deletionKind_enum" AS ENUM ('E2E', 'INACTIVE', 'MANUAL');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DO $$ BEGIN
        CREATE TYPE "core"."workspace_deletionPhase_enum" AS ENUM ('MEMBERS', 'METADATA', 'SCHEMA', 'CACHE', 'EXTERNAL_CLEANUP', 'CORE_ROW');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "core"."workspace"
        ADD COLUMN IF NOT EXISTS "deletionKind" "core"."workspace_deletionKind_enum",
        ADD COLUMN IF NOT EXISTS "deletionPhase" "core"."workspace_deletionPhase_enum",
        ADD COLUMN IF NOT EXISTS "deletionRequestedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "deletionLastProgressAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "deletionAttemptCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "deletionLastErrorCode" varchar(100),
        ADD COLUMN IF NOT EXISTS "deletionLastErrorMessage" varchar(1000)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_WORKSPACE_DELETION_RECOVERY"
      ON "core"."workspace" ("activationStatus", "deletionLastProgressAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "core"."IDX_WORKSPACE_DELETION_RECOVERY"`,
    );
    await queryRunner.query(`
      ALTER TABLE "core"."workspace"
        DROP COLUMN IF EXISTS "deletionLastErrorMessage",
        DROP COLUMN IF EXISTS "deletionLastErrorCode",
        DROP COLUMN IF EXISTS "deletionAttemptCount",
        DROP COLUMN IF EXISTS "deletionLastProgressAt",
        DROP COLUMN IF EXISTS "deletionRequestedAt",
        DROP COLUMN IF EXISTS "deletionPhase",
        DROP COLUMN IF EXISTS "deletionKind"
    `);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "core"."workspace_deletionPhase_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "core"."workspace_deletionKind_enum"`,
    );
  }
}
