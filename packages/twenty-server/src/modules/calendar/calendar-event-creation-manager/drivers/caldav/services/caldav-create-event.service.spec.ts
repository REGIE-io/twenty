import { Test } from '@nestjs/testing';

import { ConnectedAccountProvider } from 'twenty-shared/types';

import { CalDavCreateEventService } from 'src/modules/calendar/calendar-event-creation-manager/drivers/caldav/services/caldav-create-event.service';
import { CalDavClientProvider } from 'src/modules/calendar/calendar-event-import-manager/drivers/caldav/providers/caldav-client.provider';
import { CalDavFetchEventsService } from 'src/modules/calendar/calendar-event-import-manager/drivers/caldav/services/caldav-fetch-events.service';
import { CalendarEventParticipantResponseStatus } from 'src/modules/calendar/common/standard-objects/calendar-event-participant.workspace-entity';

describe('CalDavCreateEventService', () => {
  it('should return participants with the response status accepted by workspace persistence', async () => {
    const module = await Test.createTestingModule({
      providers: [
        CalDavCreateEventService,
        {
          provide: CalDavClientProvider,
          useValue: {
            getClient: jest.fn().mockResolvedValue({
              createCalendarObject: jest.fn().mockResolvedValue(undefined),
            }),
          },
        },
        {
          provide: CalDavFetchEventsService,
          useValue: {
            listEventCalendars: jest
              .fn()
              .mockResolvedValue([
                { url: 'https://caldav.example.com/calendar/' },
              ]),
            fetchEventsByHrefs: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    const event = await module
      .get(CalDavCreateEventService)
      .createCalendarEvent(
        {
          title: 'Planning meeting',
          startsAt: '2026-08-13T09:00:00Z',
          endsAt: '2026-08-13T10:00:00Z',
          isFullDay: false,
          timeZone: 'UTC',
          attendees: [
            { email: 'attendee@example.com', displayName: 'Attendee' },
          ],
          sendInvitations: true,
          addConferencing: false,
        },
        {
          id: 'account-123',
          provider: ConnectedAccountProvider.IMAP_SMTP_CALDAV,
        },
      );

    expect(event.participants).toEqual([
      {
        displayName: 'Attendee',
        handle: 'attendee@example.com',
        responseStatus: CalendarEventParticipantResponseStatus.NEEDS_ACTION,
        isOrganizer: false,
      },
    ]);

    await module.close();
  });
});
