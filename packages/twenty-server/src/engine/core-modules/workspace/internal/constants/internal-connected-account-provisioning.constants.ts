// Neither table carries a unique constraint upstream, so two concurrent attaches would
// both miss the find-then-insert and leave a duplicate channel Regie can never detach.
export const ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

export const ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX = 'attach-connected-account';
