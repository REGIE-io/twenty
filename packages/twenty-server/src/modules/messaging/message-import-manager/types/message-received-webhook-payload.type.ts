// Thin by design: enough for the receiver to filter, dedupe and correlate without a
// callback, then fetch the body and participants from the GraphQL API by messageId when
// it decides it cares.
//
// messageId is Twenty's record id. headerMessageId is the RFC 5322 Message-ID as the
// provider stored it, angle brackets included, which is what a sender that generated the
// email already holds and can match on. messageExternalId is the provider's own id.
export type MessageSyncWebhookPayload = {
  eventName: string;
  webhookId: string;
  workspaceId: string;
  messageId: string;
  messageExternalId: string;
  headerMessageId: string | null;
  threadId: string | null;
  channelId: string;
  connectedAccountId: string;
  handle: string;
  to: string[];
  direction: 'INCOMING' | 'OUTGOING';
  receivedAt: string | null;
};

export type CallMessageSyncWebhookJobData = {
  targetUrl: string;
  secret: string;
  webhookId: string;
  workspaceId: string;
  payload: MessageSyncWebhookPayload;
};
