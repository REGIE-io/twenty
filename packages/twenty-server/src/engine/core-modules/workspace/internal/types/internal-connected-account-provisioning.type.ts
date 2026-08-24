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
  regieMailboxId: string;
  calendarVisibility?: CalendarChannelVisibility;
  verifyTokenDelegation?: boolean;
};

export type AttachConnectedAccountResult = {
  connectedAccountId: string;
  calendarChannelId: string;
  created: boolean;
};

export type DetachConnectedAccountResult = {
  // Channels are disabled rather than deleted, so already-synced meetings stay
  // attributable and the sync cursor survives for a later re-enable.
  disabledCalendarChannelIds: string[];
};
