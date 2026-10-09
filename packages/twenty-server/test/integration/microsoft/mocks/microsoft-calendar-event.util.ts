import { randomUUID } from 'node:crypto';

import { type Event } from '@microsoft/microsoft-graph-types';

import { calendarSlotInDays } from 'test/integration/utils/calendar-slot-in-days.util';

export const microsoftCalendarEvent = (
  overrides: Partial<Event> = {},
): Event => {
  const id = overrides.id ?? `microsoft-calendar-event-${randomUUID()}`;
  const { startsAt, endsAt } = calendarSlotInDays(1);

  return {
    id,
    iCalUId: `${id}@microsoft.com`,
    subject: `Calendar event ${id}`,
    isCancelled: false,
    isAllDay: false,
    start: { dateTime: startsAt, timeZone: 'UTC' },
    end: { dateTime: endsAt, timeZone: 'UTC' },
    createdDateTime: '2023-11-01T00:00:00.000Z',
    lastModifiedDateTime: '2023-11-01T00:00:00.000Z',
    attendees: [],
    ...overrides,
  };
};
