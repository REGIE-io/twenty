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
