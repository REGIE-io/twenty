import { randomUUID } from 'node:crypto';

import {
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
} from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';

import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarRefreshSyncWindowCronJob } from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-refresh-sync-window.cron.job';

import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { calendarSlotInDays } from 'test/integration/utils/calendar-slot-in-days.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { expectCalendarSyncWindow } from 'test/integration/utils/expect-calendar-sync-window.util';
import { findImportedCalendarEventTitles } from 'test/integration/utils/find-imported-records.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';
import { runSyncCron } from 'test/integration/utils/run-sync-cron.util';

const HANDLE = 'google-calendar-bounded-sync-window@apple.dev';
const SYNC_TOKEN = 'google-sync-window-sync-token';
const CURSOR_BEFORE_REFRESH = 'google-sync-window-cursor-before-refresh';

const googleCalendarEventInDays = (days: number, summary: string) => {
  const { startsAt, endsAt } = calendarSlotInDays(days);

  return googleCalendarEvent({
    summary,
    start: { dateTime: startsAt },
    end: { dateTime: endsAt },
  });
};

const calendarChannelRepository = () =>
  getCoreRepository<CalendarChannelEntity>(CalendarChannelEntity);

describe('Google calendar bounded sync window (integration)', () => {
  const google = setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  const findCalendarChannel = () =>
    calendarChannelRepository().findOneByOrFail({
      id: channel.calendarChannelId,
    });

  const lastListRequest = () =>
    google.calendarEventListRequests[
      google.calendarEventListRequests.length - 1
    ];

  const seedDueChannel = (
    change: Partial<
      Pick<CalendarChannelEntity, 'isSyncEnabled' | 'syncCursor'>
    > = {},
  ) =>
    calendarChannelRepository().update(
      { id: channel.calendarChannelId },
      {
        isSyncEnabled: true,
        syncCursor: CURSOR_BEFORE_REFRESH,
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
        createdAt: new Date(),
        ...change,
      },
    );

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('bounds the initial list fetch to the rolling window and imports only events inside it', async () => {
    const inWindowTitle = `In-window event ${randomUUID()}`;
    const beforeWindowTitle = `Before-window event ${randomUUID()}`;
    const afterWindowTitle = `After-window event ${randomUUID()}`;

    await calendarChannelRepository().update(
      { id: channel.calendarChannelId },
      { syncCursor: '' },
    );

    google.serveCalendarEvents(
      [
        googleCalendarEventInDays(1, inWindowTitle),
        googleCalendarEventInDays(-60, beforeWindowTitle),
        googleCalendarEventInDays(120, afterWindowTitle),
      ],
      { nextSyncToken: SYNC_TOKEN },
    );

    const requestedAfter = new Date();

    await runCalendarChannelListFetch(channel.calendarChannelId);

    const requestedBefore = new Date();
    const listRequest = lastListRequest();

    expect(listRequest.get('syncToken')).toBeNull();
    expectCalendarSyncWindow({
      requestedStart: listRequest.get('timeMin'),
      requestedEnd: listRequest.get('timeMax'),
      requestedAfter,
      requestedBefore,
    });
    expect((await findCalendarChannel()).syncCursor).toBe(SYNC_TOKEN);

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(
      await findImportedCalendarEventTitles([
        inWindowTitle,
        beforeWindowTitle,
        afterWindowTitle,
      ]),
    ).toEqual([inWindowTitle]);
  }, 60000);

  it('continues from the saved sync token without reapplying the window', async () => {
    await runCalendarChannelListFetch(channel.calendarChannelId);

    const listRequest = lastListRequest();

    expect(listRequest.get('syncToken')).toBe(SYNC_TOKEN);
    expect(listRequest.get('timeMin')).toBeNull();
    expect(listRequest.get('timeMax')).toBeNull();
  }, 60000);

  it('clears the cursor of a due channel so the next fetch restarts the window', async () => {
    const refreshedTitle = `Refreshed event ${randomUUID()}`;

    await seedDueChannel();
    await runSyncCron(CalendarRefreshSyncWindowCronJob);

    expect(await findCalendarChannel()).toMatchObject({
      syncCursor: '',
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    });

    google.serveCalendarEvents([googleCalendarEventInDays(1, refreshedTitle)]);

    const requestedAfter = new Date();

    await runCalendarChannelListFetch(channel.calendarChannelId);

    const requestedBefore = new Date();
    const listRequest = lastListRequest();

    expect(listRequest.get('syncToken')).toBeNull();
    expectCalendarSyncWindow({
      requestedStart: listRequest.get('timeMin'),
      requestedEnd: listRequest.get('timeMax'),
      requestedAfter,
      requestedBefore,
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(await findImportedCalendarEventTitles([refreshedTitle])).toEqual([
      refreshedTitle,
    ]);
  }, 60000);

  it.each([
    { reason: 'sync is disabled', change: { isSyncEnabled: false } },
    { reason: 'it has no cursor', change: { syncCursor: '' } },
  ])(
    'leaves the channel untouched when $reason',
    async ({ change }) => {
      await seedDueChannel(change);

      const channelBefore = await findCalendarChannel();

      await runSyncCron(CalendarRefreshSyncWindowCronJob);

      expect(await findCalendarChannel()).toEqual(channelBefore);
    },
    60000,
  );

  describe('when the workspace is suspended', () => {
    const workspaceRepository = () =>
      getCoreRepository<WorkspaceEntity>(WorkspaceEntity);

    let workspaceId: string;

    beforeEach(async () => {
      workspaceId = (await findCalendarChannel()).workspaceId;

      await workspaceRepository().update(workspaceId, {
        activationStatus: WorkspaceActivationStatus.SUSPENDED,
      });
    });

    afterEach(async () => {
      await workspaceRepository().update(workspaceId, {
        activationStatus: WorkspaceActivationStatus.ACTIVE,
      });
    });

    it('leaves a due channel untouched', async () => {
      await seedDueChannel();

      const channelBefore = await findCalendarChannel();

      await runSyncCron(CalendarRefreshSyncWindowCronJob);

      expect(await findCalendarChannel()).toEqual(channelBefore);
    }, 60000);
  });
});
