export type ProvisionWorkspaceMemberInput = {
  workspaceId: string;
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

export type ProvisionWorkspaceMemberResult = {
  workspaceMemberId: string;
  userId: string;
  appUserId: string;
  workspaceId: string;
};

export const WORKSPACE_MEMBER_PROFILE_POLICIES = [
  'provider',
  'fill_missing',
] as const;

export type WorkspaceMemberProfilePolicy =
  (typeof WORKSPACE_MEMBER_PROFILE_POLICIES)[number];

export type UpdateWorkspaceMemberProfileInput = {
  workspaceId: string;
  workspaceMemberId: string;
  email: string;
  firstName: string;
  lastName: string;
  profilePolicy: WorkspaceMemberProfilePolicy;
};

export type UpdateWorkspaceMemberProfileResult = {
  workspaceMemberId: string;
  workspaceId: string;
};
