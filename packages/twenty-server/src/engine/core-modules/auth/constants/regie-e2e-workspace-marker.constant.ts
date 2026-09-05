export const REGIE_E2E_WORKSPACE_MARKER_KEY =
  'regie-internal:e2e-workspace-marker';

export type RegieE2eWorkspaceMarker = {
  ephemeral: true;
  organizationId: string;
  workspaceSlug: string;
};

export const REGIE_E2E_ORGANIZATION_ID_PREFIX = 'org_e2e_';
export const REGIE_E2E_WORKSPACE_SLUG_PREFIX = 'org-e2e-';
export const REGIE_E2E_PURGE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
export const REGIE_E2E_PURGE_BATCH_SIZE = 10;
