import { type QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { type FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

const CALENDAR_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME =
  'IDX_CALENDAR_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID';
const MESSAGE_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME =
  'IDX_MESSAGE_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID';

// The upstream merge added four instance commands to the 2-25 directory, which
// this instance had already passed. The runner resumes from a cursor and never
// revisits earlier positions, so those four never execute here — leaving the
// pageLayoutWidget type enum without its message campaign values, agentMessage
// without isHidden, and three indexes missing.
//
// Re-applying them from the current version directory is the only way to reach
// them. Every statement is idempotent, so this is a no-op on any database where
// the 2-25 originals did run (a fresh install, for instance).
//
// ALTER TYPE ... ADD VALUE replaces the original's rename/create/swap/drop of the
// whole enum type: additive, and safe inside the runner's transaction on
// PostgreSQL 12+. The new values are only read by later commands in separate
// transactions, which is the one restriction that would otherwise apply.
@RegisteredInstanceCommand('2.27.0', 1785900000000)
export class ReapplyStranded225InstanceCommandsFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "core"."pageLayoutWidget_type_enum" ADD VALUE IF NOT EXISTS 'MESSAGE_CAMPAIGN_BODY'`,
    );
    await queryRunner.query(
      `ALTER TYPE "core"."pageLayoutWidget_type_enum" ADD VALUE IF NOT EXISTS 'MESSAGE_CAMPAIGN_DETAILS'`,
    );

    await queryRunner.query(
      'ALTER TABLE "core"."agentMessage" ADD COLUMN IF NOT EXISTS "isHidden" boolean NOT NULL DEFAULT false',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "IDX_AGENT_MESSAGE_THREAD_ID_IS_HIDDEN_UNIQUE" ON "core"."agentMessage" ("threadId") WHERE "isHidden" = true',
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_APP_TOKEN_TYPE_VALUE_SSO_EXCHANGE_UNIQUE" ON "core"."appToken" ("type", "value") WHERE "type" = 'SSO_EXCHANGE_TOKEN' AND "deletedAt" IS NULL AND "revokedAt" IS NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${CALENDAR_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME}" ON "core"."calendarChannel" ("webhookSubscriptionExternalId") WHERE "webhookSubscriptionExternalId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${MESSAGE_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME}" ON "core"."messageChannel" ("webhookSubscriptionExternalId") WHERE "webhookSubscriptionExternalId" IS NOT NULL`,
    );
  }

  // Enum values are intentionally not removed: PostgreSQL cannot drop one while
  // rows may reference it, and the 2-25 originals own that rollback anyway.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "core"."${MESSAGE_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME}"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "core"."${CALENDAR_CHANNEL_WEBHOOK_SUBSCRIPTION_EXTERNAL_ID_INDEX_NAME}"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "core"."IDX_APP_TOKEN_TYPE_VALUE_SSO_EXCHANGE_UNIQUE"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "core"."IDX_AGENT_MESSAGE_THREAD_ID_IS_HIDDEN_UNIQUE"`,
    );
    await queryRunner.query(
      'ALTER TABLE "core"."agentMessage" DROP COLUMN IF EXISTS "isHidden"',
    );
  }
}
