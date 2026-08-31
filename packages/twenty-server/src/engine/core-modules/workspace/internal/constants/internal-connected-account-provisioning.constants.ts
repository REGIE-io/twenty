// Attach is find-then-insert on both the connected account and its calendar channel, and
// neither table carries a unique constraint upstream. Two calls arriving together would
// both miss the lookup and insert, leaving a second channel that Regie never records — and
// therefore can never detach, so it would keep syncing after the rep turns sync off.
export const ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT =
  'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

export const ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX = 'attach-connected-account';

// Marks a connected account that Regie provisioned, recording which mailbox it came from.
//
// Nothing reads this today: the account holds its own tokens and refreshes through the
// stock path, so it behaves exactly like a natively connected one. It is written because
// it is the only way to identify an orphan — attach writes to Twenty before Regie records
// the link, so a failure between the two leaves an account here that Regie has no row for,
// and without this marker it is indistinguishable from an account a user connected
// themselves.
//
// Stored in connectionParameters because it is the only free-form column on the entity,
// and its CHECK constraint validates the IMAP/SMTP/CalDAV password paths only.
export const REGIE_MAILBOX_ID_PARAMETER_KEY = 'regieMailboxId';
