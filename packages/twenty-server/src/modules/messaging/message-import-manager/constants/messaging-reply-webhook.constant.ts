// Custom outbound webhook event for a synced incoming email. Not one of Twenty's record
// webhooks: the sync import bulk-inserts messages and bypasses the record-event emitter,
// so this is dispatched explicitly from the save path. Shaped as <object>.<action> so it
// matches through the same operation grammar registered webhooks already use.
export const MESSAGE_RECEIVED_WEBHOOK_EVENT = 'message.received';

// A registered webhook receives the event when any of these appears in its operations
// array, mirroring Twenty's own record-webhook matching (exact, object-wildcard,
// action-wildcard, full-wildcard).
export const buildMessageReceivedWebhookOperationsToMatch = (): string[] => [
  MESSAGE_RECEIVED_WEBHOOK_EVENT,
  'message.*',
  '*.received',
  '*.*',
];
