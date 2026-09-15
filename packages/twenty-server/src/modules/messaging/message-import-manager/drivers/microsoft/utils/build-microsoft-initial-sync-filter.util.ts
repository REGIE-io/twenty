import { computeInitialSyncCutoff } from 'src/modules/messaging/message-import-manager/utils/compute-initial-sync-cutoff.util';

// Graph accepts only receivedDateTime ge/gt as a $filter on a message delta query, and the
// value must be an unquoted DateTimeOffset without fractional seconds. Spaces are encoded
// because this string is used inside a $batch request URL.
export const buildMicrosoftInitialSyncFilter = (
  now: Date = new Date(),
): string => {
  const cutoff = computeInitialSyncCutoff(now)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  return `$filter=receivedDateTime%20ge%20${cutoff}`;
};
