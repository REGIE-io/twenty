import crypto from 'crypto';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import { WorkspaceDeletionKind } from 'src/engine/core-modules/workspace/types/workspace-deletion-lifecycle.type';
import { type InternalWorkspaceProvisioningService } from 'src/engine/core-modules/auth/services/internal-workspace-provisioning.service';
import { type WorkspaceDeletionCoordinatorService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-coordinator.service';
import { type WorkspaceDeletionLifecycleStore } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-lifecycle.store';
import { type WorkspaceDeletionPhaseRunnersService } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-phase-runners.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

jest.useRealTimers();
jest.setTimeout(120_000);

type WorkspaceCatalogInventory = {
  constraints: number;
  indexes: number;
  relations: number;
  routines: number;
  triggers: number;
  types: number;
};

describe('workspace deletion PostgreSQL catalog cleanup', () => {
  beforeAll(async () => {
    const queryRunner = global.testDataSource.createQueryRunner();

    await queryRunner.connect();
    try {
      await new AddWorkspaceDeletionLifecycleFastInstanceCommand().up(
        queryRunner,
      );
    } finally {
      await queryRunner.release();
    }
  });

  const readCatalogInventory = async (
    schemaName: string,
  ): Promise<WorkspaceCatalogInventory> => {
    const [inventory] = await global.testDataSource.query(
      `SELECT
        (SELECT count(*)::int
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1) AS relations,
        (SELECT count(*)::int
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1 AND relation.relkind IN ('i', 'I')) AS indexes,
        (SELECT count(*)::int
         FROM pg_constraint constraint_row
         JOIN pg_namespace namespace ON namespace.oid = constraint_row.connamespace
         WHERE namespace.nspname = $1) AS constraints,
        (SELECT count(*)::int
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = $1 AND NOT trigger_row.tgisinternal) AS triggers,
        (SELECT count(*)::int
         FROM pg_proc routine
         JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
         WHERE namespace.nspname = $1) AS routines,
        (SELECT count(*)::int
         FROM pg_type type_row
         JOIN pg_namespace namespace ON namespace.oid = type_row.typnamespace
         WHERE namespace.nspname = $1) AS types`,
      [schemaName],
    );

    return inventory;
  };

  it('removes every object in the workspace schema and workspace-owned core rows', async () => {
    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const organizationId = `org_e2e_catalog_${runId}`;
    const workspaceSlug = `org-e2e-catalog-${runId}`;
    const provisioning =
      getAppProviderByClassName<InternalWorkspaceProvisioningService>(
        'InternalWorkspaceProvisioningService',
      );
    const lifecycleStore =
      getAppProviderByClassName<WorkspaceDeletionLifecycleStore>(
        'WorkspaceDeletionLifecycleStore',
      );
    const coordinator =
      getAppProviderByClassName<WorkspaceDeletionCoordinatorService>(
        'WorkspaceDeletionCoordinatorService',
      );
    const phaseRunners =
      getAppProviderByClassName<WorkspaceDeletionPhaseRunnersService>(
        'WorkspaceDeletionPhaseRunnersService',
      );
    const workspace = await provisioning.createWorkspace({
      name: `Deletion catalog ${runId}`,
      slug: workspaceSlug,
      ephemeral: true,
      organizationId,
    });
    const workspaceId = workspace.workspaceId;
    const schemaName = getWorkspaceSchemaName(workspaceId);

    try {
      const before = await readCatalogInventory(schemaName);
      const [schemaBefore] = await global.testDataSource.query(
        'SELECT to_regnamespace($1)::text AS schema',
        [schemaName],
      );
      const [ownedRowsBefore] = await global.testDataSource.query(
        `SELECT
          (SELECT count(*)::int FROM core.workspace WHERE id = $1) AS workspace,
          (SELECT count(*)::int FROM core."userWorkspace" WHERE "workspaceId" = $1) AS memberships,
          (SELECT count(*)::int FROM core."objectMetadata" WHERE "workspaceId" = $1) AS objects,
          (SELECT count(*)::int FROM core."fieldMetadata" WHERE "workspaceId" = $1) AS fields,
          (SELECT count(*)::int FROM core."keyValuePair" WHERE "workspaceId" = $1) AS key_values`,
        [workspaceId],
      );

      expect(before.relations).toBeGreaterThan(0);
      expect(schemaBefore.schema).toBe(schemaName);
      expect(before.indexes).toBeGreaterThan(0);
      expect(before.constraints).toBeGreaterThan(0);
      expect(before.types).toBeGreaterThan(0);
      expect(ownedRowsBefore).toEqual({
        workspace: 1,
        memberships: expect.any(Number),
        objects: expect.any(Number),
        fields: expect.any(Number),
        key_values: expect.any(Number),
      });
      expect(ownedRowsBefore.memberships).toBeGreaterThan(0);
      expect(ownedRowsBefore.objects).toBeGreaterThan(0);
      expect(ownedRowsBefore.fields).toBeGreaterThan(0);
      expect(ownedRowsBefore.key_values).toBeGreaterThan(0);

      await expect(
        lifecycleStore.requestInstantHardDeletion(
          workspaceId,
          WorkspaceDeletionKind.E2E,
          new Date(),
        ),
      ).resolves.not.toBeNull();
      const result = await coordinator.execute(
        workspaceId,
        phaseRunners.build(),
        {
          now: new Date(),
          staleAfterMs: 30_000,
          maxAttempts: 3,
        },
      );

      if (
        result.status === 'retryable-failure' ||
        result.status === 'terminal-failure'
      ) {
        throw result.error;
      }

      expect(result).toMatchObject({ status: 'completed' });

      await expect(readCatalogInventory(schemaName)).resolves.toEqual({
        relations: 0,
        indexes: 0,
        constraints: 0,
        triggers: 0,
        routines: 0,
        types: 0,
      });
      await expect(
        global.testDataSource.query(
          `SELECT
            to_regnamespace($1)::text AS workspace_schema,
            to_regnamespace('core')::text AS core_schema,
            to_regclass('core.workspace')::text AS workspace_table`,
          [schemaName],
        ),
      ).resolves.toEqual([
        {
          workspace_schema: null,
          core_schema: 'core',
          workspace_table: 'core.workspace',
        },
      ]);
      await expect(
        global.testDataSource.query(
          `SELECT
            (SELECT count(*)::int FROM core.workspace WHERE id = $1) AS workspace,
            (SELECT count(*)::int FROM core."userWorkspace" WHERE "workspaceId" = $1) AS memberships,
            (SELECT count(*)::int FROM core."objectMetadata" WHERE "workspaceId" = $1) AS objects,
            (SELECT count(*)::int FROM core."fieldMetadata" WHERE "workspaceId" = $1) AS fields,
            (SELECT count(*)::int FROM core."keyValuePair" WHERE "workspaceId" = $1) AS key_values`,
          [workspaceId],
        ),
      ).resolves.toEqual([
        {
          workspace: 0,
          memberships: 0,
          objects: 0,
          fields: 0,
          key_values: 0,
        },
      ]);
    } finally {
      await global.testDataSource.query(
        `DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`,
      );
      await global.testDataSource.query(
        `DELETE FROM core.workspace WHERE id = $1`,
        [workspaceId],
      );
    }
  });
});
