import { calendarSyncWindow } from 'src/modules/calendar/calendar-event-import-manager/constants/calendar-sync-window.constant';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('calendarSyncWindow', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');

  it('reaches back 30 days', () => {
    expect(calendarSyncWindow(now).startDateTime.toISOString()).toBe(
      '2026-08-05T12:00:00.000Z',
    );
  });

  it('reaches forward 90 days', () => {
    expect(calendarSyncWindow(now).endDateTime.toISOString()).toBe(
      '2026-12-03T12:00:00.000Z',
    );
  });

  it('recomputes from the clock rather than a fixed anchor', () => {
    const later = new Date(now.getTime() + 10 * MS_PER_DAY);

    expect(calendarSyncWindow(later).startDateTime.getTime()).toBe(
      calendarSyncWindow(now).startDateTime.getTime() + 10 * MS_PER_DAY,
    );
  });

  // Resets happen on a channel's creation day-of-month, so one created on the 29th-31st
  // skips February: Jan 30 to Mar 30 is 59 days. Below that the window lapses, silently.
  it('leaves margin beyond the longest gap between resets', () => {
    const { endDateTime } = calendarSyncWindow(now);

    expect(endDateTime.getTime() - now.getTime()).toBeGreaterThan(
      59 * MS_PER_DAY,
    );
  });
});
