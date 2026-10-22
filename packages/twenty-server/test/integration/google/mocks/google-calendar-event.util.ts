import { randomUUID } from 'node:crypto';

import { type calendar_v3 } from 'googleapis';

import { calendarSlotInDays } from 'test/integration/utils/calendar-slot-in-days.util';

export const googleCalendarEvent = (
  overrides: Partial<calendar_v3.Schema$Event> = {},
): calendar_v3.Schema$Event => {
  const id = overrides.id ?? `google-calendar-event-${randomUUID()}`;
  const { startsAt, endsAt } = calendarSlotInDays(1);

  return {
    id,
    iCalUID: `${id}@google.com`,
    summary: `Calendar event ${id}`,
    status: 'confirmed',
    start: { dateTime: startsAt },
    end: { dateTime: endsAt },
    created: '2023-11-01T00:00:00.000Z',
    updated: '2023-11-01T00:00:00.000Z',
    attendees: [],
    ...overrides,
  };
};
