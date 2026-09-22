export const REGIE_E2E_WORKSPACE_MARKER_KEY =
  'regie-internal:e2e-workspace-marker';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_KEY =
  'regie-internal:legacy-e2e-orphan-marker';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_KIND = 'LEGACY_ORPHAN';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_SOURCE =
  'reviewed-cross-database-backfill';
export const REGIE_CI_WORKSPACE_OWNER = 'go-crm-ci';
export const REGIE_CI_WORKSPACE_LEASE_MS = 60 * 60 * 1000;

export type RegieCiWorkspaceOwner = {
  repository: string;
  runId: string;
  runAttempt: number;
  job: string;
};

export type RegieE2eWorkspaceMarker = {
  ephemeral: true;
  organizationId: string;
  workspaceSlug: string;
  owner?: typeof REGIE_CI_WORKSPACE_OWNER;
  ciOwner?: RegieCiWorkspaceOwner;
  issuedAt?: string;
  expiresAt?: string;
};

export type RegieLegacyE2eOrphanMarker = {
  ephemeral: true;
  kind: typeof REGIE_LEGACY_E2E_ORPHAN_MARKER_KIND;
  workspaceId: string;
  workspaceSlug: string;
  authorizedAt: string;
  source: typeof REGIE_LEGACY_E2E_ORPHAN_MARKER_SOURCE;
};

export const REGIE_E2E_ORGANIZATION_ID_PREFIX = 'org_e2e_';
export const REGIE_E2E_WORKSPACE_SLUG_PREFIX = 'org-e2e-';
export const REGIE_E2E_PURGE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
export const REGIE_E2E_PURGE_BATCH_SIZE = 15;
