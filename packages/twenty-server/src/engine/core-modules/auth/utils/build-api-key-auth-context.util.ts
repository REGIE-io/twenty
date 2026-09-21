import { type RegieSource } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';

import { type RawAuthContext } from 'src/engine/core-modules/auth/types/raw-auth-context.type';
import { type ApiKeyWorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';

type ApiKeyAuthContextInput = {
  workspace: NonNullable<RawAuthContext['workspace']>;
  apiKey: NonNullable<RawAuthContext['apiKey']>;
  regieSource?: RegieSource;
  workspaceMemberId?: RawAuthContext['workspaceMemberId'];
};

export const buildApiKeyAuthContext = (
  input: ApiKeyAuthContextInput,
): ApiKeyWorkspaceAuthContext => {
  return {
    type: 'apiKey',
    workspace: input.workspace,
    apiKey: input.apiKey,
    ...(isDefined(input.regieSource) ? { regieSource: input.regieSource } : {}),
    ...(isDefined(input.workspaceMemberId)
      ? { workspaceMemberId: input.workspaceMemberId }
      : {}),
  };
};
