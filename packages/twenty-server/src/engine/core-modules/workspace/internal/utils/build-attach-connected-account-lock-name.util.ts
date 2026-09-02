import { type ConnectedAccountProvider } from 'twenty-shared/types';

import { ATTACH_CONNECTED_ACCOUNT_LOCK_PREFIX } from 'src/engine/core-modules/workspace/internal/constants/internal-connected-account-provisioning.constants';

// Keyed on the tuple findOrCreateConnectedAccount looks up on. hashtextextended narrows it
// to 64 bits, so a collision costs one attach a brief wait, never a wrong result.
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
