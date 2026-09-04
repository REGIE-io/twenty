import { isNonEmptyString } from '@sniptt/guards';

import { computeInitialSyncCutoff } from 'src/modules/messaging/message-import-manager/utils/compute-initial-sync-cutoff.util';

// Gmail reads `after:` as an epoch in seconds, which avoids the timezone ambiguity of the
// YYYY/MM/DD form the same operator also accepts.
export const computeGmailInitialSyncSearchFilter = (
  excludedSearchFilter: string,
  now: Date = new Date(),
): string => {
  const cutoffInSeconds = Math.floor(
    computeInitialSyncCutoff(now).getTime() / 1000,
  );

  const afterFilter = `after:${cutoffInSeconds}`;

  return isNonEmptyString(excludedSearchFilter)
    ? `${excludedSearchFilter} ${afterFilter}`
    : afterFilter;
};
