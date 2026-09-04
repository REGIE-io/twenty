import {
  type CalendarChannelVisibility,
  type ConnectedAccountProvider,
  type MessageChannelVisibility,
} from 'twenty-shared/types';

export type AttachConnectedAccountInput = {
  workspaceId: string;
  provider: ConnectedAccountProvider;
  handle: string;
  // The member's Regie address, which is how they were provisioned here. Distinct from
  // the handle: a rep may connect a mailbox that is not their login address.
  memberEmail: string;
  // Regie owns the OAuth grant and hands both tokens over at attach. Twenty then refreshes
  // through its own stock path, exactly as it would for a natively connected account.
  accessToken: string;
  refreshToken: string;
  calendarVisibility?: CalendarChannelVisibility;
  messageVisibility?: MessageChannelVisibility;
  // Both omitted or true. Set one to false to attach the account without that channel;
  // set both to false to record the account only, which syncs nothing.
  withCalendarChannel?: boolean;
  withMessageChannel?: boolean;
};

export type AttachConnectedAccountResult = {
  connectedAccountId: string;
  // Each is absent when the attach asked for no channel of that kind.
  calendarChannelId?: string;
  messageChannelId?: string;
  created: boolean;
};

export type DetachConnectedAccountResult = {
  // Channels are disabled rather than deleted, so already-synced meetings and messages
  // stay attributable and the sync cursor survives for a later re-enable.
  disabledCalendarChannelIds: string[];
  disabledMessageChannelIds: string[];
};
