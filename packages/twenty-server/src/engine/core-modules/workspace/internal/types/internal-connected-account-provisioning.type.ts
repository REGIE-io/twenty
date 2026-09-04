import {
  type CalendarChannelVisibility,
  type ConnectedAccountProvider,
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
  // Omitted or true creates the calendar channel. False records the account only.
  withCalendarChannel?: boolean;
};

export type AttachConnectedAccountResult = {
  connectedAccountId: string;
  // Absent when the attach asked for no calendar channel.
  calendarChannelId?: string;
  created: boolean;
};

export type DetachConnectedAccountResult = {
  // Channels are disabled rather than deleted, so already-synced meetings stay
  // attributable and the sync cursor survives for a later re-enable.
  disabledCalendarChannelIds: string[];
};
