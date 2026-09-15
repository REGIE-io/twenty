// Custom outbound webhook events for synced emails. Not Twenty's record webhooks: the
// sync import bulk-inserts messages and bypasses the record-event emitter, so these are
// dispatched explicitly from the save path. Shaped as <object>.<action> so they match
// through the same operation grammar registered webhooks already use.
export const MESSAGE_RECEIVED_WEBHOOK_EVENT = 'message.received';
export const MESSAGE_SENT_WEBHOOK_EVENT = 'message.sent';

// A registered webhook receives an event when any of these appears in its operations
// array, mirroring Twenty's own record-webhook matching (exact, object-wildcard,
// action-wildcard, full-wildcard). Kept separate per event so a receiver already
// subscribed to message.received does not start getting sent mail it never asked for.
export const buildMessageWebhookOperationsToMatch = (
  eventName: string,
): string[] => {
  const [objectName, actionName] = eventName.split('.');

  return [eventName, `${objectName}.*`, `*.${actionName}`, '*.*'];
};
