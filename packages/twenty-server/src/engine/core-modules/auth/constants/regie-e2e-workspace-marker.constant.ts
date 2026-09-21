export const REGIE_E2E_WORKSPACE_MARKER_KEY =
  'regie-internal:e2e-workspace-marker';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_KEY =
  'regie-internal:legacy-e2e-orphan-marker';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_KIND = 'LEGACY_ORPHAN';
export const REGIE_LEGACY_E2E_ORPHAN_MARKER_SOURCE =
  'reviewed-cross-database-backfill';

export type RegieE2eWorkspaceMarker = {
  ephemeral: true;
  organizationId: string;
  workspaceSlug: string;
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
