import { type ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';

export const REGIE_MAILBOX_ID_PARAMETER_KEY = 'regieMailboxId';

// Marks an account whose OAuth grant lives in Regie rather than here. Stored in
// connectionParameters because it is the only free-form column on the entity, and its
// CHECK constraint validates the IMAP/SMTP/CalDAV password paths only.
export const getDelegatedMailboxId = (
  connectedAccount: Pick<ConnectedAccountEntity, 'connectionParameters'>,
): string | null => {
  const mailboxId =
    connectedAccount.connectionParameters?.[REGIE_MAILBOX_ID_PARAMETER_KEY];

  return typeof mailboxId === 'string' && mailboxId.length > 0
    ? mailboxId
    : null;
};
