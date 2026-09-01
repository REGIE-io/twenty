// Attach is find-then-insert on both the connected account and its calendar channel, and
// neither table carries a unique constraint upstream. Two calls arriving together would
// both miss the lookup and insert, leaving a second channel that Regie never records — and
// therefore can never detach, so it would keep syncing after the rep turns sync off.
export const ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

export const ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX = 'attach-connected-account';
