import { randomUUID } from 'node:crypto';

import {
  CalendarChannelSyncStage,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarRefreshSyncWindowCronJob } from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-refresh-sync-window.cron.job';

import { microsoftCalendarEvent } from 'test/integration/microsoft/mocks/microsoft-calendar-event.util';
import { setupMicrosoftMock } from 'test/integration/microsoft/mocks/setup-microsoft-mock.util';
import { calendarSlotInDays } from 'test/integration/utils/calendar-slot-in-days.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import { expectCalendarSyncWindow } from 'test/integration/utils/expect-calendar-sync-window.util';
import { findImportedCalendarEventTitles } from 'test/integration/utils/find-imported-records.util';
import { getCoreRepository } from 'test/integration/utils/get-core-repository.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';
import { runSyncCron } from 'test/integration/utils/run-sync-cron.util';

const HANDLE = 'microsoft-calendar-bounded-sync-window@apple.dev';
const DELTA_TOKEN = 'microsoft-sync-window-delta-token';

const microsoftCalendarEventInDays = (days: number, subject: string) => {
  const { startsAt, endsAt } = calendarSlotInDays(days);

  return microsoftCalendarEvent({
    subject,
    start: { dateTime: startsAt, timeZone: 'UTC' },
    end: { dateTime: endsAt, timeZone: 'UTC' },
  });
};

const calendarChannelRepository = () =>
  getCoreRepository<CalendarChannelEntity>(CalendarChannelEntity);

describe('Microsoft calendar bounded sync window (integration)', () => {
  const microsoft = setupMicrosoftMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  const findCalendarChannel = () =>
    calendarChannelRepository().findOneByOrFail({
      id: channel.calendarChannelId,
    });

  const lastDeltaRequest = () =>
    microsoft.calendarEventListRequests[
      microsoft.calendarEventListRequests.length - 1
    ];

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.MICROSOFT,
      handle: HANDLE,
    });
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('bounds the initial calendarView delta to the rolling window and imports only events inside it', async () => {
    const inWindowTitle = `In-window event ${randomUUID()}`;
    const beforeWindowTitle = `Before-window event ${randomUUID()}`;
    const afterWindowTitle = `After-window event ${randomUUID()}`;

    await calendarChannelRepository().update(
      { id: channel.calendarChannelId },
      { syncCursor: '' },
    );

    microsoft.serveCalendarEvents(
      [
        microsoftCalendarEventInDays(1, inWindowTitle),
        microsoftCalendarEventInDays(-60, beforeWindowTitle),
        microsoftCalendarEventInDays(120, afterWindowTitle),
      ],
      { deltaToken: DELTA_TOKEN },
    );

    const requestedAfter = new Date();

    await runCalendarChannelListFetch(channel.calendarChannelId);

    const requestedBefore = new Date();
    const deltaRequest = lastDeltaRequest();

    expect(deltaRequest.get('$deltatoken')).toBeNull();
    expectCalendarSyncWindow({
      requestedStart: deltaRequest.get('startDateTime'),
      requestedEnd: deltaRequest.get('endDateTime'),
      requestedAfter,
      requestedBefore,
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(
      await findImportedCalendarEventTitles([
        inWindowTitle,
        beforeWindowTitle,
        afterWindowTitle,
      ]),
    ).toEqual([inWindowTitle]);
  }, 60000);

  it('continues from the saved delta link without reapplying the window', async () => {
    microsoft.serveCalendarEvents([]);

    await runCalendarChannelListFetch(channel.calendarChannelId);

    const deltaRequest = lastDeltaRequest();

    expect(deltaRequest.get('$deltatoken')).toBe(DELTA_TOKEN);
    expect(deltaRequest.get('startDateTime')).toBeNull();
    expect(deltaRequest.get('endDateTime')).toBeNull();
  }, 60000);

  it('clears the delta link of a due channel so the next fetch restarts the window', async () => {
    const refreshedTitle = `Refreshed event ${randomUUID()}`;

    await calendarChannelRepository().update(
      { id: channel.calendarChannelId },
      {
        syncStage: CalendarChannelSyncStage.CALENDAR_EVENTS_IMPORT_PENDING,
      },
    );
    await runSyncCron(CalendarRefreshSyncWindowCronJob);

    expect(await findCalendarChannel()).toMatchObject({
      syncCursor: '',
      syncStage: CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
    });

    microsoft.serveCalendarEvents([
      microsoftCalendarEventInDays(1, refreshedTitle),
    ]);

    const requestedAfter = new Date();

    await runCalendarChannelListFetch(channel.calendarChannelId);

    const requestedBefore = new Date();
    const deltaRequest = lastDeltaRequest();

    expect(deltaRequest.get('$deltatoken')).toBeNull();
    expectCalendarSyncWindow({
      requestedStart: deltaRequest.get('startDateTime'),
      requestedEnd: deltaRequest.get('endDateTime'),
      requestedAfter,
      requestedBefore,
    });

    await runCalendarChannelEventsImport(channel.calendarChannelId);

    expect(await findImportedCalendarEventTitles([refreshedTitle])).toEqual([
      refreshedTitle,
    ]);
  }, 60000);
});
