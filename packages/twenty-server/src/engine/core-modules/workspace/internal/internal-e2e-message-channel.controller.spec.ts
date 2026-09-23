import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import request from 'supertest';
import {
  ConnectedAccountProvider,
  MessageChannelPendingGroupEmailsAction,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  MessageChannelType,
  MessageChannelVisibility,
} from 'twenty-shared/types';
import { FindOperator } from 'typeorm';

import {
  REGIE_CI_WORKSPACE_LEASE_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { InternalE2eMessageChannelController } from 'src/engine/core-modules/workspace/internal/internal-e2e-message-channel.controller';
import { InternalE2eMessageChannelService } from 'src/engine/core-modules/workspace/internal/internal-e2e-message-channel.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';

const workspaceId = '20202020-0000-4000-8000-000000000001';
const token = 'test-only-internal-metadata-token';
const ciOwner = {
  repository: 'REGIE-io/go',
  runId: '123',
  runAttempt: 1,
  job: 'CRM API (schema)',
};
const input = {
  ciOwner,
  memberEmail: 'crm.fixture.owner@example.test',
  handle: 'crm.message.fixture@example.test',
};
type Row = Record<string, unknown>;

describe('CI-owned disabled message channel HTTP fixture', () => {
  let app: INestApplication;
  let workspace: Row;
  let marker: Row;
  let userWorkspaces: Row[];
  let accounts: Row[];
  let channels: Row[];
  let transactionCount: number;

  beforeAll(async () => {
    jest.useRealTimers();
    const rows = new Map<Function, () => Row[]>([
      [WorkspaceEntity, () => [workspace]],
      [
        KeyValuePairEntity,
        () => [
          {
            key: REGIE_E2E_WORKSPACE_MARKER_KEY,
            workspaceId,
            type: KeyValuePairType.USER_VARIABLE,
            userId: null,
            applicationId: null,
            deletedAt: null,
            value: marker,
          },
        ],
      ],
      [
        UserEntity,
        () => [{ id: 'user-1', email: input.memberEmail, deletedAt: null }],
      ],
      [UserWorkspaceEntity, () => userWorkspaces],
      [ConnectedAccountEntity, () => accounts],
      [MessageChannelEntity, () => channels],
    ]);
    const manager = {
      getRepository(entity: Function) {
        const entries = rows.get(entity);
        if (!entries) throw new Error('Unexpected persistence dependency');
        const find = (where: Row) =>
          entries().find((row) =>
            Object.entries(where).every(([key, value]) =>
              value instanceof FindOperator
                ? value.type === 'isNull' && row[key] == null
                : row[key] === value,
            ),
          ) ?? null;
        return {
          findOne: async ({ where }: { where: Row }) => find(where),
          findOneBy: async (where: Row) => find(where),
          create: (value: Row) => value,
          save: async (value: Row) => {
            const saved = { id: randomUUID(), archivedAt: null, ...value };
            entries().push(saved);
            return saved;
          },
        };
      },
    };
    const module = await Test.createTestingModule({
      controllers: [InternalE2eMessageChannelController],
      providers: [
        InternalE2eMessageChannelService,
        InternalMetadataTokenGuard,
        NoPermissionGuard,
        { provide: TwentyConfigService, useValue: { get: () => token } },
        {
          provide: getRepositoryToken(WorkspaceEntity),
          useValue: {
            manager: {
              transaction: async (
                operation: (transaction: typeof manager) => Promise<unknown>,
              ) => {
                transactionCount += 1;
                return operation(manager);
              },
            },
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    const issuedAt = Date.now() - 1000;
    workspace = {
      id: workspaceId,
      subdomain: 'org-e2e-fixture',
      deletedAt: null,
    };
    marker = {
      ephemeral: true,
      organizationId: 'org_e2e_fixture',
      workspaceSlug: workspace.subdomain,
      owner: 'go-crm-ci',
      ciOwner,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + REGIE_CI_WORKSPACE_LEASE_MS).toISOString(),
    };
    userWorkspaces = [
      { id: 'member-1', userId: 'user-1', workspaceId, deletedAt: null },
    ];
    accounts = [];
    channels = [];
    transactionCount = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (body: object = input) =>
    request(app.getHttpServer())
      .post(`/internal/workspaces/${workspaceId}/e2e/message-channel`)
      .set('x-internal-token', token)
      .send(body);

  it('creates persisted tokenless and disabled native rows and reuses them on retry', async () => {
    const created = await post().expect(200);
    expect(created.body).toEqual({
      connectedAccountId: accounts[0].id,
      messageChannelId: channels[0].id,
      created: true,
    });
    expect(accounts[0]).toMatchObject({
      workspaceId,
      userWorkspaceId: 'member-1',
      handle: input.handle,
      provider: ConnectedAccountProvider.GOOGLE,
      accessToken: null,
      refreshToken: null,
      connectionParameters: null,
      scopes: [],
    });
    expect(channels[0]).toMatchObject({
      workspaceId,
      connectedAccountId: accounts[0].id,
      handle: input.handle,
      type: MessageChannelType.EMAIL,
      visibility: MessageChannelVisibility.SHARE_EVERYTHING,
      isSyncEnabled: false,
      isContactAutoCreationEnabled: false,
      syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
      syncStatus: MessageChannelSyncStatus.NOT_SYNCED,
      pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
    });
    const reused = await post().expect(200);
    expect(reused.body).toEqual({ ...created.body, created: false });
    expect(accounts).toHaveLength(1);
    expect(channels).toHaveLength(1);
  });

  it('requires the internal metadata token before touching persistence', async () => {
    await request(app.getHttpServer())
      .post(`/internal/workspaces/${workspaceId}/e2e/message-channel`)
      .send(input)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/internal/workspaces/${workspaceId}/e2e/message-channel`)
      .set('x-internal-token', 'wrong')
      .send(input)
      .expect(403);
    expect(transactionCount).toBe(0);
  });

  it.each(['repository', 'runId', 'runAttempt', 'job'])(
    'rejects a different %s in the recorded owner',
    async (key) => {
      await post({
        ...input,
        ciOwner: { ...ciOwner, [key]: key === 'runAttempt' ? 2 : 'different' },
      }).expect(400);
      expect(accounts).toHaveLength(0);
      expect(channels).toHaveLength(0);
    },
  );

  it.each([
    'production',
    'deleted',
    'not-ephemeral',
    'expired',
    'future',
    'marker-slug',
    'missing-owner',
  ])('refuses %s workspace metadata without writes', async (variation) => {
    if (variation === 'production') workspace.subdomain = 'customer';
    if (variation === 'deleted') workspace.deletedAt = new Date();
    if (variation === 'not-ephemeral') marker.ephemeral = false;
    if (variation === 'missing-owner') delete marker.ciOwner;
    if (variation === 'marker-slug') marker.workspaceSlug = 'org-e2e-another';
    if (variation === 'expired' || variation === 'future') {
      const issuedAt =
        Date.now() +
        (variation === 'expired' ? -REGIE_CI_WORKSPACE_LEASE_MS - 1000 : 1000);
      marker.issuedAt = new Date(issuedAt).toISOString();
      marker.expiresAt = new Date(
        issuedAt + REGIE_CI_WORKSPACE_LEASE_MS,
      ).toISOString();
    }
    await post().expect(400);
    expect(accounts).toHaveLength(0);
    expect(channels).toHaveLength(0);
  });

  it('rejects foreign or deleted membership and malformed or extra payload fields', async () => {
    userWorkspaces[0].workspaceId = randomUUID();
    await post().expect(400);
    userWorkspaces[0].workspaceId = workspaceId;
    userWorkspaces[0].deletedAt = new Date();
    await post().expect(400);
    for (const body of [
      { ...input, ciOwner: undefined },
      { ...input, handle: 'customer@example.com' },
      { ...input, accessToken: 'forbidden' },
      { ...input, ciOwner: { ...ciOwner, extra: true } },
    ]) {
      await post(body).expect(400);
    }
    expect(accounts).toHaveLength(0);
  });

  it('refuses to overwrite credentialed accounts or activate changed existing channels', async () => {
    await post().expect(200);
    accounts[0].accessToken = 'enc:v2:real-grant';
    await post().expect(400);
    expect(accounts[0].accessToken).toBe('enc:v2:real-grant');
    accounts[0].accessToken = null;
    channels[0].isSyncEnabled = true;
    await post().expect(400);
    expect(channels[0].isSyncEnabled).toBe(true);
    expect(accounts).toHaveLength(1);
    expect(channels).toHaveLength(1);
  });
});
