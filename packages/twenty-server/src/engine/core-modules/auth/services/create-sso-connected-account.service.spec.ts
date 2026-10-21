import { ConnectedAccountProvider } from 'twenty-shared/types';
import { FindOperator } from 'typeorm';

import { CreateSSOConnectedAccountService } from 'src/engine/core-modules/auth/services/create-sso-connected-account.service';
import { CALENDAR_ONLY_CONNECTED_ACCOUNT_NAME } from 'src/engine/core-modules/workspace/internal/constants/internal-connected-account-provisioning.constants';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';
const USER_ID = 'user-1';
const USER_WORKSPACE_ID = 'user-workspace-1';
const HANDLE = 'rep@example.com';
const PREVIOUS_SCOPES = ['calendar'];
const SSO_SCOPES = ['openid', 'email'];

const SSO_SIGN_IN = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  handle: HANDLE,
  provider: ConnectedAccountProvider.GOOGLE,
  scopes: SSO_SCOPES,
};

type StoredConnectedAccount = {
  id: string;
  workspaceId: string;
  userWorkspaceId: string;
  provider: ConnectedAccountProvider;
  handle: string;
  name: string | null;
  scopes: string[];
};

const makeServiceHarness = (seededAccounts: StoredConnectedAccount[]) => {
  const connectedAccounts = new Map(
    seededAccounts.map((account) => [account.id, { ...account }]),
  );

  const connectedAccountRepository = {
    findOneBy: jest.fn(
      async (criteria: Record<string, unknown>) =>
        Array.from(connectedAccounts.values()).find((account) =>
          Object.entries(criteria).every(([field, value]) => {
            const stored = account[field as keyof StoredConnectedAccount];

            return value instanceof FindOperator && value.type === 'isNull'
              ? stored === null || stored === undefined
              : stored === value;
          }),
        ) ?? null,
    ),
    update: jest.fn(
      async (id: string, values: Partial<StoredConnectedAccount>) => {
        const existing = connectedAccounts.get(id);

        if (existing !== undefined) {
          connectedAccounts.set(id, { ...existing, ...values });
        }
      },
    ),
    save: jest.fn(async (values: Partial<StoredConnectedAccount>) => {
      const saved = {
        name: null,
        ...values,
        id: `connected-account-${connectedAccounts.size + 1}`,
      } as StoredConnectedAccount;

      connectedAccounts.set(saved.id, saved);

      return saved;
    }),
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
        userId === USER_ID && workspaceId === WORKSPACE_ID
          ? { id: USER_WORKSPACE_ID }
          : null,
    ),
  };

  const service = new CreateSSOConnectedAccountService(
    connectedAccountRepository as never,
    userWorkspaceRepository as never,
  );

  return { service, connectedAccounts };
};

const makeStoredAccount = (
  id: string,
  name: string | null,
): StoredConnectedAccount => ({
  id,
  workspaceId: WORKSPACE_ID,
  userWorkspaceId: USER_WORKSPACE_ID,
  provider: ConnectedAccountProvider.GOOGLE,
  handle: HANDLE,
  name,
  scopes: PREVIOUS_SCOPES,
});

describe('CreateSSOConnectedAccountService', () => {
  describe('createOrUpdateSSOConnectedAccount', () => {
    it('updates the mailbox account and leaves the calendar-only account on the same address alone', async () => {
      const { service, connectedAccounts } = makeServiceHarness([
        makeStoredAccount(
          'calendar-only',
          CALENDAR_ONLY_CONNECTED_ACCOUNT_NAME,
        ),
        makeStoredAccount('mailbox', null),
      ]);

      await service.createOrUpdateSSOConnectedAccount(SSO_SIGN_IN);

      expect(connectedAccounts.get('mailbox')?.scopes).toEqual(SSO_SCOPES);
      expect(connectedAccounts.get('calendar-only')?.scopes).toEqual(
        PREVIOUS_SCOPES,
      );
    });

    it('creates a separate account when only a calendar-only account exists on the address', async () => {
      const { service, connectedAccounts } = makeServiceHarness([
        makeStoredAccount(
          'calendar-only',
          CALENDAR_ONLY_CONNECTED_ACCOUNT_NAME,
        ),
      ]);

      await service.createOrUpdateSSOConnectedAccount(SSO_SIGN_IN);

      expect(connectedAccounts.get('calendar-only')?.scopes).toEqual(
        PREVIOUS_SCOPES,
      );
      expect(
        Array.from(connectedAccounts.values()).map(({ name, scopes }) => ({
          name,
          scopes,
        })),
      ).toEqual([
        { name: CALENDAR_ONLY_CONNECTED_ACCOUNT_NAME, scopes: PREVIOUS_SCOPES },
        { name: null, scopes: SSO_SCOPES },
      ]);
    });
  });
});
