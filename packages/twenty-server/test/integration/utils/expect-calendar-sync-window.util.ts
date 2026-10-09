import { calendarSyncWindow } from 'src/modules/calendar/calendar-event-import-manager/constants/calendar-sync-window.constant';

export const expectCalendarSyncWindow = ({
  requestedStart,
  requestedEnd,
  requestedAfter,
  requestedBefore,
}: {
  requestedStart: string | null | undefined;
  requestedEnd: string | null | undefined;
  requestedAfter: Date;
  requestedBefore: Date;
}): void => {
  const earliestWindow = calendarSyncWindow(requestedAfter);
  const latestWindow = calendarSyncWindow(requestedBefore);
  const start = Date.parse(requestedStart ?? '');
  const end = Date.parse(requestedEnd ?? '');

  expect(start).toBeGreaterThanOrEqual(earliestWindow.startDateTime.getTime());
  expect(start).toBeLessThanOrEqual(latestWindow.startDateTime.getTime());
  expect(end).toBeGreaterThanOrEqual(earliestWindow.endDateTime.getTime());
  expect(end).toBeLessThanOrEqual(latestWindow.endDateTime.getTime());
};
