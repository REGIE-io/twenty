import { type Event } from '@microsoft/microsoft-graph-types';
import { http, HttpResponse } from 'msw';

import { type MswHandler } from 'test/integration/utils/http-mock.util';
import { isEventInRequestedWindow } from 'test/integration/utils/is-event-in-requested-window.util';

export const microsoftCalendarEventsHandlers = (
  events: Event[],
  deltaToken: string,
  calendarEventListRequests: URLSearchParams[],
): MswHandler[] => [
  http.get('*/me/calendarView/delta', ({ request }) => {
    const { searchParams } = new URL(request.url);

    calendarEventListRequests.push(searchParams);

    return HttpResponse.json({
      value: events
        .filter((event) =>
          isEventInRequestedWindow(event, {
            from: searchParams.get('startDateTime'),
            to: searchParams.get('endDateTime'),
          }),
        )
        .map((event) => ({ id: event.id })),
      '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=${deltaToken}`,
    });
  }),
  // The list fetch collects ids from calendarView, but the import still reads each event
  // from /me/calendar/events/{id}.
  ...events.map((event) =>
    http.get(`*/me/calendar/events/${event.id}`, () =>
      HttpResponse.json(event),
    ),
  ),
];
