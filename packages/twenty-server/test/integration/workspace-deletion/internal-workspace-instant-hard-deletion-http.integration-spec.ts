import crypto from 'crypto';

import request from 'supertest';

import { AddWorkspaceDeletionLifecycleFastInstanceCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-instance-command-fast-1789196612599-add-workspace-deletion-lifecycle';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { type WorkspaceDeletionQueueAdapter } from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-queue.adapter';

import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';

jest.useRealTimers();
jest.setTimeout(120_000);

type WorkspaceFixture = {
  organizationId?: string;
  workspaceId: string;
  workspaceSlug: string;
};

describe('internal instant hard deletion HTTP safety boundary', () => {
  let queue: WorkspaceDeletionQueueAdapter;
  let enqueueSpy: jest.SpyInstance;
  let configGetSpy: jest.SpyInstance;
  let workspaces: WorkspaceFixture[] = [];

  const internalToken = 'workspace-deletion-integration-token';

  const insertWorkspace = async ({
    ephemeral,
    marker = ephemeral,
  }: {
    ephemeral: boolean;
    marker?: boolean;
  }) => {
    const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const workspaceId = crypto.randomUUID();
    const organizationId = ephemeral ? `org_e2e_http_${runId}` : undefined;
    const workspaceSlug = ephemeral
      ? `org-e2e-http-${runId}`
      : `customer-http-${runId}`;
    const workspace = { organizationId, workspaceId, workspaceSlug };

    await global.testDataSource.query(
      `INSERT INTO core.workspace (
        id, subdomain, "activationStatus", "workspaceCustomApplicationId",
        "defaultRoleId", "databaseSchema"
      )
      SELECT $1, $2, 'ACTIVE', application.id, role.id, $3
      FROM core.application application
      CROSS JOIN core.role role
      LIMIT 1`,
      [
        workspaceId,
        workspaceSlug,
        `workspace_${workspaceId.replaceAll('-', '')}`,
      ],
    );

    if (marker) {
      await global.testDataSource.query(
        `INSERT INTO core."keyValuePair" ("workspaceId", key, value, type)
         VALUES (
           $1,
           'regie-internal:e2e-workspace-marker',
           jsonb_build_object(
             'ephemeral', true,
             'organizationId', $2::text,
             'workspaceSlug', $3::text
           ),
           'USER_VARIABLE'
         )`,
        [workspaceId, organizationId, workspaceSlug],
      );
    }

    workspaces.push(workspace);

    return workspace;
  };

  const postDeletion = (
    workspaceId: string,
    body: { organizationId: string; workspaceSlug: string },
    token: string | null | undefined = internalToken,
  ) => {
    const pendingRequest = request(global.app.getHttpServer())
      .post(`/internal/workspaces/${workspaceId}/instant-hard-deletion`)
      .send(body);

    return token
      ? pendingRequest.set('x-internal-token', token)
      : pendingRequest;
  };

  const expectWorkspaceUnchanged = async (workspaceId: string) => {
    const [workspace] = await global.testDataSource.query(
      `SELECT "activationStatus", "deletionKind", "deletionPhase"
       FROM core.workspace
       WHERE id = $1`,
      [workspaceId],
    );

    expect(workspace).toEqual({
      activationStatus: 'ACTIVE',
      deletionKind: null,
      deletionPhase: null,
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  };

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

    queue = getAppProviderByClassName<WorkspaceDeletionQueueAdapter>(
      'WorkspaceDeletionQueueAdapter',
    );
    enqueueSpy = jest.spyOn(queue, 'enqueue').mockResolvedValue(undefined);

    const config = getAppProviderByClassName<TwentyConfigService>(
      'TwentyConfigService',
    );
    const originalGet = config.get.bind(config);

    configGetSpy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: Parameters<TwentyConfigService['get']>[0]) =>
        key === 'TWENTY_INTERNAL_METADATA_TOKEN'
          ? internalToken
          : originalGet(key)) as TwentyConfigService['get']);
  });

  beforeEach(() => {
    workspaces = [];
    enqueueSpy.mockClear();
  });

  afterEach(async () => {
    enqueueSpy.mockClear();
    await global.testDataSource.query(
      'DELETE FROM core.workspace WHERE id = ANY($1::uuid[])',
      [workspaces.map(({ workspaceId }) => workspaceId)],
    );
  });

  afterAll(() => {
    enqueueSpy.mockRestore();
    configGetSpy.mockRestore();
  });

  it('admits and queues only an exact persistently marked E2E identity', async () => {
    const workspace = await insertWorkspace({ ephemeral: true });

    await postDeletion(workspace.workspaceId, {
      organizationId: workspace.organizationId!,
      workspaceSlug: workspace.workspaceSlug,
    })
      .expect(202)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          operation: 'instant-hard-deletion',
          workspaceId: workspace.workspaceId,
          status: 'PENDING_DELETION',
          phase: 'MEMBERS',
          completed: false,
        });
      });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith({
      workspaceId: workspace.workspaceId,
      jobId: `workspace-delete-${workspace.workspaceId}`,
    });
  });

  it('refuses an ordinary workspace and leaves it active and unqueued', async () => {
    const workspace = await insertWorkspace({
      ephemeral: false,
      marker: false,
    });

    await postDeletion(workspace.workspaceId, {
      organizationId: 'org_e2e_forged',
      workspaceSlug: 'org-e2e-forged',
    }).expect(400);

    await expectWorkspaceUnchanged(workspace.workspaceId);
  });

  it('refuses a malformed persistent marker and leaves the workspace unchanged', async () => {
    const workspace = await insertWorkspace({ ephemeral: true });

    await global.testDataSource.query(
      `UPDATE core."keyValuePair"
       SET value = jsonb_set(value, '{ephemeral}', 'false'::jsonb)
       WHERE "workspaceId" = $1
         AND key = 'regie-internal:e2e-workspace-marker'`,
      [workspace.workspaceId],
    );

    await postDeletion(workspace.workspaceId, {
      organizationId: workspace.organizationId!,
      workspaceSlug: workspace.workspaceSlug,
    }).expect(400);

    await expectWorkspaceUnchanged(workspace.workspaceId);
  });

  it('refuses wrong organization and slug identities without changing state', async () => {
    const workspace = await insertWorkspace({ ephemeral: true });

    await postDeletion(workspace.workspaceId, {
      organizationId: 'org_e2e_someone_else',
      workspaceSlug: workspace.workspaceSlug,
    }).expect(400);
    await expectWorkspaceUnchanged(workspace.workspaceId);

    await postDeletion(workspace.workspaceId, {
      organizationId: workspace.organizationId!,
      workspaceSlug: 'org-e2e-someone-else',
    }).expect(400);
    await expectWorkspaceUnchanged(workspace.workspaceId);
  });

  it('requires the internal token before reading or changing deletion state', async () => {
    const workspace = await insertWorkspace({ ephemeral: true });

    await postDeletion(
      workspace.workspaceId,
      {
        organizationId: workspace.organizationId!,
        workspaceSlug: workspace.workspaceSlug,
      },
      null,
    ).expect(403);

    await expectWorkspaceUnchanged(workspace.workspaceId);
  });
});
