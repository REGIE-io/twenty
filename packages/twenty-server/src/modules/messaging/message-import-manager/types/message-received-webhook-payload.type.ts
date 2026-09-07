// Thin by design: enough for the receiver to filter and dedupe (messageExternalId is the
// provider's stable id) without a callback, then fetch the body and participants from the
// GraphQL API by messageId when it decides it cares.
export type MessageReceivedWebhookPayload = {
  eventName: string;
  webhookId: string;
  workspaceId: string;
  messageId: string;
  messageExternalId: string;
  threadId: string | null;
  channelId: string;
  connectedAccountId: string;
  handle: string;
  direction: 'INCOMING';
  receivedAt: string | null;
};

export type CallMessageReceivedWebhookJobData = {
  targetUrl: string;
  secret: string;
  webhookId: string;
  workspaceId: string;
  payload: MessageReceivedWebhookPayload;
};
