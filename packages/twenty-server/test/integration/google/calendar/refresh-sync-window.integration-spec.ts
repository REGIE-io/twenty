import {
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarRefreshSyncWindowCronJob } from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-refresh-sync-window.cron.job';

import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { runSyncCron } from 'test/integration/utils/run-sync-cron.util';

const DUE_HANDLE = 'calendar-window-due@apple.dev';
const NOT_DUE_HANDLE = 'calendar-window-not-due@apple.dev';

const WINDOWED_CURSOR = 'windowed-sync-cursor';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

describe('Calendar sync window refresh (integration)', () => {
  const gmail = setupGoogleMock({ handle: DUE_HANDLE });

  let dueChannel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let notDueChannel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    dueChannel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: DUE_HANDLE,
    });

    gmail.actAsAccount(NOT_DUE_HANDLE);

    notDueChannel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: NOT_DUE_HANDLE,
    });
  }, 120000);

  afterAll(async () => {
    await dueChannel?.cleanup().catch(() => undefined);
    await notDueChannel?.cleanup().catch(() => undefined);
  });

  it('drops the cursor of a channel created on this day of the month and leaves the others', async () => {
    const calendarChannelRepository = getCoreRepository<CalendarChannelEntity>(
      CalendarChannelEntity,
    );

    await calendarChannelRepository.update(
      { id: dueChannel.calendarChannelId },
      {
        isSyncEnabled: true,
        syncCursor: WINDOWED_CURSOR,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
        createdAt: new Date(),
      },
    );

    await calendarChannelRepository.update(
      { id: notDueChannel.calendarChannelId },
      {
        isSyncEnabled: true,
        syncCursor: WINDOWED_CURSOR,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
        createdAt: new Date(Date.now() - TWO_DAYS_MS),
      },
    );

    await runSyncCron(CalendarRefreshSyncWindowCronJob);

    const dueChannelAfter = await calendarChannelRepository.findOneByOrFail({
      id: dueChannel.calendarChannelId,
    });

    expect(dueChannelAfter.syncCursor).toBe('');
    expect(dueChannelAfter.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    );

    const notDueChannelAfter = await calendarChannelRepository.findOneByOrFail({
      id: notDueChannel.calendarChannelId,
    });

    expect(notDueChannelAfter.syncCursor).toBe(WINDOWED_CURSOR);
    expect(notDueChannelAfter.syncStage).toBe(
      CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_SCHEDULED,
    );
  }, 60000);
});
