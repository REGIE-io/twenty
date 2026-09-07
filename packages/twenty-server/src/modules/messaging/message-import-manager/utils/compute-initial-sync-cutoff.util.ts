import { subDays } from 'date-fns';

import { MESSAGING_INITIAL_SYNC_LOOKBACK_DAYS } from 'src/modules/messaging/message-import-manager/constants/messaging-initial-sync-lookback.constant';

export const computeInitialSyncCutoff = (now: Date = new Date()): Date =>
  subDays(now, MESSAGING_INITIAL_SYNC_LOOKBACK_DAYS);
