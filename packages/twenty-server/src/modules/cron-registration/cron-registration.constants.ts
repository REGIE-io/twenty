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
  CALENDAR_REFRESH_SYNC_WINDOW_CRON_PATTERN,
  CalendarRefreshSyncWindowCronJob,
} from 'src/modules/calendar/calendar-event-import-manager/crons/jobs/calendar-refresh-sync-window.cron.job';
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
import {
  REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
  RegieE2eWorkspaceDeletionDiscoveryJob,
} from 'src/engine/workspace-manager/workspace-cleaner/crons/regie-e2e-workspace-deletion-discovery.job';
import { type ConfigVariables } from 'src/engine/core-modules/twenty-config/config-variables';

export type CronToRegister = {
  jobName: string;
  pattern: string;
  enabledConfigKey?: keyof ConfigVariables;
};

/**
 * The messaging crons, held back from CRONS_TO_REGISTER on purpose.
 *
 * Email sync drives the message.sent / message.received webhooks, and the receiving side
 * is still being built. Registering these would start delivering to an endpoint that is
 * not ready, so they stay off until it is. Nothing else about the sync is disabled: the
 * `cron:*` commands still register them on demand, and re-enabling here is a one-line
 * spread into the list below.
 *
 * Note that CronRegistrationService only upserts; it never removes. Spreading these back
 * in starts them, but taking them out again does not stop a scheduler already written to
 * Redis by an earlier boot or by a `cron:*` command.
 */
export const MESSAGING_CRONS_TO_REGISTER: CronToRegister[] = [
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

/**
 * Crons the worker registers for itself at boot. Add an entry to enable one.
 *
 * Patterns are imported from the job files rather than restated, so this cannot drift from
 * what the equivalent `cron:*` command would register. (Note that
 * calendar-event-list-fetch.cron.command.ts keeps its own local copy of the same pattern
 * instead of importing the exported one; this list uses the exported constant.)
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
    jobName: CalendarRefreshSyncWindowCronJob.name,
    pattern: CALENDAR_REFRESH_SYNC_WINDOW_CRON_PATTERN,
  },
  {
    jobName: RegieE2eWorkspaceDeletionDiscoveryJob.name,
    pattern: REGIE_E2E_WORKSPACE_DELETION_CRON_PATTERN,
    enabledConfigKey: 'REGIE_E2E_WORKSPACE_DELETION_CRON_ENABLED',
  },
];
