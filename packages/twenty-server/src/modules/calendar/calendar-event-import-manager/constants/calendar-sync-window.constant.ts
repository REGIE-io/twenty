const PAST_DAYS = 30;
const FUTURE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const calendarSyncWindow = (
  now: Date = new Date(),
): { startDateTime: Date; endDateTime: Date } => ({
  startDateTime: new Date(now.getTime() - PAST_DAYS * MS_PER_DAY),
  endDateTime: new Date(now.getTime() + FUTURE_DAYS * MS_PER_DAY),
});
