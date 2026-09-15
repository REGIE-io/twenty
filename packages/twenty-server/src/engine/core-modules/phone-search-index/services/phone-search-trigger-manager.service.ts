import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource } from 'typeorm';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

/** Installs the one stable trigger; this intentionally never changes Person DDL. */
@Injectable()
export class PhoneSearchTriggerManagerService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async install({
    workspaceId,
    objectMetadataId,
  }: {
    workspaceId: string;
    objectMetadataId: string;
  }): Promise<void> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const queryRunner = this.dataSource.createQueryRunner();
    const expectedTriggerArguments = Buffer.from(
      `${workspaceId}\0${objectMetadataId}\0`,
    ).toString('hex');

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      const [{ isInstalled }] = (await queryRunner.query(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1
              AND c.relname = 'person'
              AND t.tgname = 'TRG_PERSON_PHONE_LOOKUP_SYNC'
              AND NOT t.tgisinternal
              AND t.tgenabled <> 'D'
              AND t.tgfoid = to_regprocedure('public.sync_person_phone_lookup()')
              AND t.tgtype = 29
              AND encode(t.tgargs, 'hex') = $2
         ) AS "isInstalled"`,
        [schema, expectedTriggerArguments],
      )) as Array<{ isInstalled: boolean }>;

      if (isInstalled) {
        await queryRunner.commitTransaction();
        return;
      }

      await queryRunner.query("SET LOCAL lock_timeout = '2s'");
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "TRG_PERSON_PHONE_LOOKUP_SYNC" ON "${schema}"."person"`,
      );
      // Values are parameters, while schema comes from the server-owned UUID
      // formatter. PostgreSQL does not accept trigger arguments as bind params.
      await queryRunner.query(
        `CREATE TRIGGER "TRG_PERSON_PHONE_LOOKUP_SYNC" AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."person" FOR EACH ROW EXECUTE FUNCTION public.sync_person_phone_lookup('${workspaceId}', '${objectMetadataId}')`,
      );
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive)
        await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
