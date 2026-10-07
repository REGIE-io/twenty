import { type calendar_v3 } from 'googleapis';
import { http, HttpResponse } from 'msw';

import { GOOGLE_CALENDAR_EVENTS_URL } from 'test/integration/google/mocks/google-calendar-events-url.constant';
import { type MswHandler } from 'test/integration/utils/http-mock.util';
import { isEventInRequestedWindow } from 'test/integration/utils/is-event-in-requested-window.util';

export const googleCalendarEventsHandlers = (
  events: calendar_v3.Schema$Event[],
  nextSyncToken: string,
  calendarEventListRequests: URLSearchParams[],
): MswHandler[] => [
  http.get(GOOGLE_CALENDAR_EVENTS_URL, ({ request }) => {
    const { searchParams } = new URL(request.url);

    calendarEventListRequests.push(searchParams);

    return HttpResponse.json<calendar_v3.Schema$Events>({
      items: events.filter((event) =>
        isEventInRequestedWindow(event, {
          from: searchParams.get('timeMin'),
          to: searchParams.get('timeMax'),
        }),
      ),
      nextSyncToken,
    });
  }),
  ...events.map((event) =>
    http.get(`${GOOGLE_CALENDAR_EVENTS_URL}/${event.id}`, () =>
      HttpResponse.json<calendar_v3.Schema$Event>(event),
    ),
  ),
];
