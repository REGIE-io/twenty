import { type Event } from '@microsoft/microsoft-graph-types';
import { http, HttpResponse } from 'msw';

import { type MswHandler } from 'test/integration/utils/http-mock.util';

export const microsoftCalendarEventsHandlers = (
  events: Event[],
  deltaToken: string,
): MswHandler[] => [
  http.get('*/me/calendarView/delta', () =>
    HttpResponse.json({
      value: events.map((event) => ({ id: event.id })),
      '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=${deltaToken}`,
    }),
  ),
  // The list fetch collects ids from calendarView, but the import still reads each event
  // from /me/calendar/events/{id}.
  ...events.map((event) =>
    http.get(`*/me/calendar/events/${event.id}`, () =>
      HttpResponse.json(event),
    ),
  ),
];
