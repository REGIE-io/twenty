import {
  CalendarChannelSyncStage,
  CalendarChannelSyncStatus,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

import { ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT } from 'src/engine/core-modules/workspace/internal/constants/internal-connected-account-provisioning.constants';
import { InternalConnectedAccountProvisioningService } from 'src/engine/core-modules/workspace/internal/internal-connected-account-provisioning.service';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';
const USER_WORKSPACE_ID = 'user-workspace-1';
const HANDLE = 'rep@example.com';
const MEMBER_EMAIL = 'rep@regie.ai';

const ATTACH_INPUT = {
  workspaceId: WORKSPACE_ID,
  provider: ConnectedAccountProvider.GOOGLE,
  handle: HANDLE,
  memberEmail: MEMBER_EMAIL,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
};

type StoredConnectedAccount = {
  id: string;
  workspaceId: string;
  userWorkspaceId: string;
  provider: ConnectedAccountProvider;
  handle: string;
  accessToken: string | null;
  refreshToken: string | null;
  lastCredentialsRefreshedAt: Date | null;
  authFailedAt: Date | null;
};

type StoredCalendarChannel = {
  id: string;
  workspaceId: string;
  connectedAccountId: string;
  isSyncEnabled: boolean;
  syncStage: CalendarChannelSyncStage;
  syncStatus: CalendarChannelSyncStatus;
  syncStageStartedAt: Date | null;
  syncCursor: string;
  throttleFailureCount: number;
};

const accountKey = ({
  workspaceId,
  userWorkspaceId,
  provider,
  handle,
}: Pick<
  StoredConnectedAccount,
  'workspaceId' | 'userWorkspaceId' | 'provider' | 'handle'
>) => `${workspaceId}:${userWorkspaceId}:${provider}:${handle}`;

const makeServiceHarness = () => {
  const connectedAccounts = new Map<string, StoredConnectedAccount>();
  const calendarChannels = new Map<string, StoredCalendarChannel>();

  let connectedAccountSequence = 0;
  let calendarChannelSequence = 0;

  const workspaceRepository = {
    findOneBy: jest.fn(async ({ id }: { id: string }) =>
      id === WORKSPACE_ID ? { id: WORKSPACE_ID } : null,
    ),
  };

  const userRepository = {
    findOneBy: jest.fn(async ({ email }: { email: string }) =>
      email === MEMBER_EMAIL ? { id: 'user-1', email } : null,
    ),
  };

  const userWorkspaceRepository = {
    findOneBy: jest.fn(
      async ({
        userId,
        workspaceId,
      }: {
        userId: string;
        workspaceId: string;
      }) =>
        userId === 'user-1' && workspaceId === WORKSPACE_ID
          ? { id: USER_WORKSPACE_ID }
          : null,
    ),
  };

  const findAccountBy = (criteria: Partial<StoredConnectedAccount>) =>
    Array.from(connectedAccounts.values()).find((account) =>
      Object.entries(criteria).every(
        ([field, value]) =>
          account[field as keyof StoredConnectedAccount] === value,
      ),
    ) ?? null;

  const transactionalConnectedAccountRepository = {
    findOneBy: jest.fn(async (criteria: Partial<StoredConnectedAccount>) =>
      findAccountBy(criteria),
    ),
    findOneByOrFail: jest.fn(
      async (criteria: Partial<StoredConnectedAccount>) => {
        const account = findAccountBy(criteria);

        if (account === null) {
          throw new Error('Connected account not found');
        }

        return account;
      },
    ),
    create: jest.fn((values: Partial<StoredConnectedAccount>) => values),
    save: jest.fn(async (values: Partial<StoredConnectedAccount>) => {
      const saved = {
        lastCredentialsRefreshedAt: null,
        authFailedAt: null,
        ...values,
        id: `connected-account-${++connectedAccountSequence}`,
      } as StoredConnectedAccount;

      connectedAccounts.set(accountKey(saved), saved);

      return saved;
    }),
    update: jest.fn(
      async (
        { id }: { id: string },
        patch: Partial<StoredConnectedAccount>,
      ) => {
        const account = findAccountBy({ id });

        if (account !== null) {
          Object.assign(account, patch);
        }
      },
    ),
  };

  const transactionalCalendarChannelRepository = {
    findOneBy: jest.fn(
      async ({ connectedAccountId }: { connectedAccountId: string }) =>
        Array.from(calendarChannels.values()).find(
          (channel) => channel.connectedAccountId === connectedAccountId,
        ) ?? null,
    ),
    update: jest.fn(
      async ({ id }: { id: string }, patch: Partial<StoredCalendarChannel>) => {
        const channel = calendarChannels.get(id);

        if (channel !== undefined) {
          Object.assign(channel, patch);
        }
      },
    ),
  };

  const queryRunner = { query: jest.fn(async () => undefined) };

  const transactionManager = {
    queryRunner,
    getRepository: jest.fn((entity: unknown) => {
      if (entity === ConnectedAccountEntity) {
        return transactionalConnectedAccountRepository;
      }

      if (entity === CalendarChannelEntity) {
        return transactionalCalendarChannelRepository;
      }

      throw new Error('Unexpected repository requested inside attach');
    }),
  };

  // Only the transaction entry point is faked here; every write inside it goes through
  // transactionManager.getRepository, exactly as the service does.
  const connectedAccountRepository = {
    manager: {
      transaction: jest.fn(
        async (runInTransaction: (manager: unknown) => unknown) =>
          runInTransaction(transactionManager),
      ),
    },
  };

  const calendarChannelRepository = {
    find: jest.fn(
      async ({
        where: { connectedAccountId, isSyncEnabled },
      }: {
        where: { connectedAccountId: string; isSyncEnabled: boolean };
      }) =>
        Array.from(calendarChannels.values()).filter(
          (channel) =>
            channel.connectedAccountId === connectedAccountId &&
            channel.isSyncEnabled === isSyncEnabled,
        ),
    ),
    update: jest.fn(
      async (_criteria: unknown, patch: { isSyncEnabled: boolean }) => {
        for (const channel of calendarChannels.values()) {
          Object.assign(channel, patch);
        }
      },
    ),
  };

  const createCalendarChannelService = {
    createCalendarChannel: jest.fn(
      async ({
        workspaceId,
        connectedAccountId,
      }: {
        workspaceId: string;
        connectedAccountId: string;
      }) => {
        const created: StoredCalendarChannel = {
          id: `calendar-channel-${++calendarChannelSequence}`,
          workspaceId,
          connectedAccountId,
          isSyncEnabled: true,
          syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
          syncStatus: CalendarChannelSyncStatus.NOT_SYNCED,
          syncStageStartedAt: null,
          syncCursor: '',
          throttleFailureCount: 0,
        };

        calendarChannels.set(created.id, created);

        return created.id;
      },
    ),
  };

  const connectedAccountTokenEncryptionService = {
    encryptTokenPair: jest.fn(
      ({
        accessToken,
        refreshToken,
      }: {
        accessToken: string;
        refreshToken: string;
      }) => ({
        encryptedAccessToken: `enc:v2:${accessToken}`,
        encryptedRefreshToken: `enc:v2:${refreshToken}`,
      }),
    ),
  };

  const service = new InternalConnectedAccountProvisioningService(
    workspaceRepository as never,
    userRepository as never,
    userWorkspaceRepository as never,
    connectedAccountRepository as never,
    calendarChannelRepository as never,
    createCalendarChannelService as never,
    connectedAccountTokenEncryptionService as never,
  );

  return {
    service,
    queryRunner,
    stores: { connectedAccounts, calendarChannels },
    repositories: {
      calendarChannelRepository,
      transactionalCalendarChannelRepository,
      transactionalConnectedAccountRepository,
    },
    createCalendarChannelService,
  };
};

const seedChannel = (
  stores: { calendarChannels: Map<string, StoredCalendarChannel> },
  overrides: Partial<StoredCalendarChannel> & { connectedAccountId: string },
): StoredCalendarChannel => {
  const channel: StoredCalendarChannel = {
    id: 'existing-calendar-channel',
    workspaceId: WORKSPACE_ID,
    isSyncEnabled: true,
    syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    syncStatus: CalendarChannelSyncStatus.ACTIVE,
    syncStageStartedAt: null,
    syncCursor: 'cursor-from-last-sync',
    throttleFailureCount: 0,
    ...overrides,
  };

  stores.calendarChannels.set(channel.id, channel);

  return channel;
};

describe('InternalConnectedAccountProvisioningService', () => {
  describe('attachConnectedAccount', () => {
    it('creates an account with encrypted tokens and a calendar channel', async () => {
      const { service, stores } = makeServiceHarness();

      const result = await service.attachConnectedAccount(ATTACH_INPUT);

      expect(result).toEqual({
        connectedAccountId: 'connected-account-1',
        calendarChannelId: 'calendar-channel-1',
        created: true,
      });
      expect(Array.from(stores.connectedAccounts.values())).toEqual([
        expect.objectContaining({
          handle: HANDLE,
          accessToken: 'enc:v2:access-token',
          refreshToken: 'enc:v2:refresh-token',
        }),
      ]);
    });

    // The lock is the only thing standing between two concurrent attaches and a duplicate
    // channel Regie can never detach, and nothing else in the flow would fail without it.
    it('takes the advisory lock keyed on the mailbox before writing', async () => {
      const { service, queryRunner } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      expect(queryRunner.query).toHaveBeenCalledWith(
        ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT,
        [
          `attach-connected-account:${WORKSPACE_ID}:${USER_WORKSPACE_ID}:${ConnectedAccountProvider.GOOGLE}:${HANDLE}`,
        ],
      );
    });

    it('reuses the existing account on re-attach rather than creating a second', async () => {
      const { service, stores } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);
      const result = await service.attachConnectedAccount(ATTACH_INPUT);

      expect(result).toEqual({
        connectedAccountId: 'connected-account-1',
        calendarChannelId: 'calendar-channel-1',
        created: false,
      });
      expect(stores.connectedAccounts.size).toBe(1);
      expect(stores.calendarChannels.size).toBe(1);
    });

    // Re-attach is how Regie hands over a reconnected grant, so the old pair must not
    // survive it, and the failure markers describing the old pair must not either.
    it('replaces the stored grant and clears the failure markers on re-attach', async () => {
      const { service, stores } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      const account = Array.from(stores.connectedAccounts.values())[0];

      account.authFailedAt = new Date('2026-08-31T19:55:00.000Z');
      account.lastCredentialsRefreshedAt = new Date('2026-08-31T19:00:00.000Z');

      await service.attachConnectedAccount({
        ...ATTACH_INPUT,
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });

      expect(account).toMatchObject({
        accessToken: 'enc:v2:new-access-token',
        refreshToken: 'enc:v2:new-refresh-token',
        authFailedAt: null,
        lastCredentialsRefreshedAt: null,
      });
    });

    it('revives a channel parked on FAILED, keeping its cursor', async () => {
      const { service, stores } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      const channel = seedChannel(stores, {
        id: 'calendar-channel-1',
        connectedAccountId: 'connected-account-1',
        syncStage: CalendarChannelSyncStage.FAILED,
        syncStatus: CalendarChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
        syncStageStartedAt: new Date('2026-08-31T19:55:00.000Z'),
        throttleFailureCount: 3,
      });

      await service.attachConnectedAccount(ATTACH_INPUT);

      expect(channel).toMatchObject({
        isSyncEnabled: true,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
        syncStageStartedAt: null,
        throttleFailureCount: 0,
        // Preserved so recovery resumes incrementally instead of recrawling.
        syncCursor: 'cursor-from-last-sync',
        // Left to the stock transitions, which overwrite it on the next fetch.
        syncStatus: CalendarChannelSyncStatus.FAILED_INSUFFICIENT_PERMISSIONS,
      });
    });

    it('re-enables a disabled healthy channel without disturbing its sync stage', async () => {
      const { service, stores } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      const channel = seedChannel(stores, {
        id: 'calendar-channel-1',
        connectedAccountId: 'connected-account-1',
        isSyncEnabled: false,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
      });

      await service.attachConnectedAccount(ATTACH_INPUT);

      expect(channel).toMatchObject({
        isSyncEnabled: true,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
        syncCursor: 'cursor-from-last-sync',
      });
    });

    // A toggle-on for an already-syncing channel must not rewrite the stage: a fetch job
    // may be running against it, and the stage machine assumes a single writer.
    it('leaves an already-enabled healthy channel untouched', async () => {
      const { service, stores, repositories } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      seedChannel(stores, {
        id: 'calendar-channel-1',
        connectedAccountId: 'connected-account-1',
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_ONGOING,
      });
      repositories.transactionalCalendarChannelRepository.update.mockClear();

      await service.attachConnectedAccount(ATTACH_INPUT);

      expect(
        repositories.transactionalCalendarChannelRepository.update,
      ).not.toHaveBeenCalled();
    });

    it('rejects a member who is not in the workspace', async () => {
      const { service, createCalendarChannelService } = makeServiceHarness();

      await expect(
        service.attachConnectedAccount({
          ...ATTACH_INPUT,
          memberEmail: 'stranger@regie.ai',
        }),
      ).rejects.toThrow('No user found for stranger@regie.ai');

      expect(
        createCalendarChannelService.createCalendarChannel,
      ).not.toHaveBeenCalled();
    });
  });

  describe('detachConnectedAccount', () => {
    it('disables the enabled channels of the account', async () => {
      const { service, stores } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);

      const result = await service.detachConnectedAccount({
        workspaceId: WORKSPACE_ID,
        connectedAccountId: 'connected-account-1',
      });

      expect(result).toEqual({
        disabledCalendarChannelIds: ['calendar-channel-1'],
      });
      expect(stores.calendarChannels.get('calendar-channel-1')).toMatchObject({
        isSyncEnabled: false,
      });
    });

    // Regie retries detach, so a second call has to be a no-op rather than an error.
    it('reports nothing disabled when the account has no enabled channel', async () => {
      const { service, repositories } = makeServiceHarness();

      await service.attachConnectedAccount(ATTACH_INPUT);
      await service.detachConnectedAccount({
        workspaceId: WORKSPACE_ID,
        connectedAccountId: 'connected-account-1',
      });
      repositories.calendarChannelRepository.update.mockClear();

      const result = await service.detachConnectedAccount({
        workspaceId: WORKSPACE_ID,
        connectedAccountId: 'connected-account-1',
      });

      expect(result).toEqual({ disabledCalendarChannelIds: [] });
      expect(
        repositories.calendarChannelRepository.update,
      ).not.toHaveBeenCalled();
    });

    it('rejects an unknown workspace', async () => {
      const { service } = makeServiceHarness();

      await expect(
        service.detachConnectedAccount({
          workspaceId: 'missing-workspace',
          connectedAccountId: 'connected-account-1',
        }),
      ).rejects.toThrow('Workspace missing-workspace not found.');
    });
  });
});
