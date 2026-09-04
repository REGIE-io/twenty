import {
  CALENDAR_EVENT_LIST_FETCH_CRON_PATTERN,
  CalendarEventListFetchCronJob,
} from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-event-list-fetch.cron.job';
import {
  CALENDAR_EVENTS_IMPORT_CRON_PATTERN,
  CalendarEventsImportCronJob,
} from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-events-import.cron.job';
import {
  CALENDAR_ONGOING_STALE_CRON_PATTERN,
  CalendarOngoingStaleCronJob,
} from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-ongoing-stale.cron.job';
import {
  CALENDAR_RELAUNCH_FAILED_CALENDAR_CHANNELS_CRON_PATTERN,
  CalendarRelaunchFailedCalendarChannelsCronJob,
} from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-relaunch-failed-calendar-channels.cron.job';
import {
  MESSAGING_MESSAGE_LIST_FETCH_CRON_PATTERN,
  MessagingMessageListFetchCronJob,
} from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-message-list-fetch.cron.job';
import {
  MESSAGING_MESSAGES_IMPORT_CRON_PATTERN,
  MessagingMessagesImportCronJob,
} from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-messages-import.cron.job';
import {
  MESSAGING_ONGOING_STALE_CRON_PATTERN,
  MessagingOngoingStaleCronJob,
} from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-ongoing-stale.cron.job';
import {
  MESSAGING_RELAUNCH_FAILED_MESSAGE_CHANNELS_CRON_PATTERN,
  MessagingRelaunchFailedMessageChannelsCronJob,
} from 'src/modules/messaging/message-import-manager/crons/jobs/messaging-relaunch-failed-message-channels.cron.job';

export type CronToRegister = {
  jobName: string;
  pattern: string;
};

/**
 * Crons the worker registers for itself at boot. Add an entry to enable one.
 *
 * Patterns are imported from the job files rather than restated, so this cannot drift from
 * what the equivalent `cron:*` command would register. (Note that
 * calendar-event-list-fetch.cron.command.ts keeps its own local copy of the same pattern
 * instead of importing the exported one; this list uses the exported constant.)
 *
 * The messaging crons are registered now that the first fetch of a mailbox is bounded to
 * MESSAGING_INITIAL_SYNC_LOOKBACK_DAYS on both providers. Without that bound the initial
 * Microsoft delta URL and Gmail list query carry no date filter and crawl entire mailboxes.
 */
export const CRONS_TO_REGISTER: CronToRegister[] = [
  {
    jobName: CalendarEventListFetchCronJob.name,
    pattern: CALENDAR_EVENT_LIST_FETCH_CRON_PATTERN,
  },
  {
    jobName: CalendarEventsImportCronJob.name,
    pattern: CALENDAR_EVENTS_IMPORT_CRON_PATTERN,
  },
  {
    jobName: CalendarOngoingStaleCronJob.name,
    pattern: CALENDAR_ONGOING_STALE_CRON_PATTERN,
  },
  {
    jobName: CalendarRelaunchFailedCalendarChannelsCronJob.name,
    pattern: CALENDAR_RELAUNCH_FAILED_CALENDAR_CHANNELS_CRON_PATTERN,
  },
  {
    jobName: MessagingMessageListFetchCronJob.name,
    pattern: MESSAGING_MESSAGE_LIST_FETCH_CRON_PATTERN,
  },
  {
    jobName: MessagingMessagesImportCronJob.name,
    pattern: MESSAGING_MESSAGES_IMPORT_CRON_PATTERN,
  },
  {
    jobName: MessagingOngoingStaleCronJob.name,
    pattern: MESSAGING_ONGOING_STALE_CRON_PATTERN,
  },
  {
    jobName: MessagingRelaunchFailedMessageChannelsCronJob.name,
    pattern: MESSAGING_RELAUNCH_FAILED_MESSAGE_CHANNELS_CRON_PATTERN,
  },
];
