import { MessageParticipantRole } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message';

// Delivery status notifications are auto-submitted, so isBulkMail drops them by default.
// Regie needs them for bounce handling downstream, so they are detected here and let
// through. Kept narrow to a DSN, not every automated mail: three independent signals, any
// of which marks a bounce.
//
// 1. The RFC 3464 report envelope: Content-Type multipart/report with a delivery-status
//    report type. This is the definitive machine marker and covers quoted or unquoted forms.
// 2. The X-Failed-Recipients header Gmail adds to a bounce.
// 3. A mailer-daemon or postmaster sender, the fallback when a provider does not surface
//    the report headers (the FROM participant is always populated by both drivers).
const BOUNCE_SENDER_LOCAL_PARTS = ['mailer-daemon', 'postmaster'];

const hasDeliveryStatusReport = (
  message: MessageWithParticipants,
): boolean =>
  (message.messageHeaders ?? []).some(({ name, value }) => {
    if (name.toLowerCase() !== 'content-type') {
      return false;
    }

    const normalized = value.toLowerCase();

    return (
      normalized.includes('multipart/report') &&
      normalized.includes('delivery-status')
    );
  });

const hasFailedRecipientsHeader = (
  message: MessageWithParticipants,
): boolean =>
  (message.messageHeaders ?? []).some(
    ({ name }) => name.toLowerCase() === 'x-failed-recipients',
  );

const isFromBounceSender = (message: MessageWithParticipants): boolean => {
  const senderHandle = message.participants
    ?.find((participant) => participant.role === MessageParticipantRole.FROM)
    ?.handle?.toLowerCase();

  if (!isDefined(senderHandle)) {
    return false;
  }

  const localPart = senderHandle.split('@')[0];

  return BOUNCE_SENDER_LOCAL_PARTS.includes(localPart);
};

export const isBounce = (message: MessageWithParticipants): boolean =>
  hasDeliveryStatusReport(message) ||
  hasFailedRecipientsHeader(message) ||
  isFromBounceSender(message);
