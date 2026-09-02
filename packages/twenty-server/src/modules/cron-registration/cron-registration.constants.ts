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
 * Messaging crons are deliberately absent: the initial Microsoft delta URL carries no date
 * filter, so registering them before email sync is bounded would crawl entire mailboxes.
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
];
