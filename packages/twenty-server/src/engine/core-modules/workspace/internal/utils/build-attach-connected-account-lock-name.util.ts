import { type ConnectedAccountProvider } from 'twenty-shared/types';

import { ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX } from 'src/engine/core-modules/workspace/internal/constants/attach-connected-account-lock.constants';

// Keyed on the same tuple findOrCreateConnectedAccount looks up on, so concurrent attaches
// for one mailbox serialize while unrelated ones stay parallel.
//
// hashtextextended narrows this to 64 bits, so two unrelated mailboxes could in principle
// share a lock. The cost of a collision is one attach briefly waiting, never a wrong result.
export const buildAttachConnectedAccountLockName = ({
  workspaceId,
  userWorkspaceId,
  provider,
  handle,
}: {
  workspaceId: string;
  userWorkspaceId: string;
  provider: ConnectedAccountProvider;
  handle: string;
}): string =>
  `${ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX}:${workspaceId}:${userWorkspaceId}:${provider}:${handle}`;
