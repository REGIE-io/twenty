import {
  ConnectedAccountProvider,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
} from 'twenty-shared/types';

import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';

import { gmailMessage } from 'test/integration/google/mocks/gmail-message.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import {
  queryConnectedAccount,
  queryMessageChannel,
} from 'test/integration/utils/query-messaging.util';
import { runMessageChannelSync } from 'test/integration/utils/run-message-channel-sync.util';

const HANDLE = 'messaging-token-refresh@apple.dev';

const EXPIRED_CREDENTIALS_AT = new Date(Date.now() - 56 * 60 * 1000);

describe('Messaging token refresh (integration)', () => {
  setupGoogleMock({ handle: HANDLE, inbox: [gmailMessage()] });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
      // Prevent OAuth onboarding import from racing the manually scheduled sync.
      skipChannelConfiguration: false,
    });
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('refreshes expired credentials and completes the sync', async () => {
    await getCoreRepository<ConnectedAccountEntity>(
      ConnectedAccountEntity,
    ).update(
      { id: channel.connectedAccountId },
      { lastCredentialsRefreshedAt: EXPIRED_CREDENTIALS_AT },
    );

    await runMessageChannelSync(channel.channelId);

    const account = await queryConnectedAccount(channel.connectedAccountId);

    expect(account.authFailedAt).toBeNull();
    expect(
      new Date(account.lastCredentialsRefreshedAt ?? 0).getTime(),
    ).toBeGreaterThan(EXPIRED_CREDENTIALS_AT.getTime());
    expect(await queryMessageChannel(channel)).toMatchObject({
      syncStatus: MessageChannelSyncStatus.ACTIVE,
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
    });
  }, 60000);
});
