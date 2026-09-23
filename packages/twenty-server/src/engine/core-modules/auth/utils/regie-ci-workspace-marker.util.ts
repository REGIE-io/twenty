import {
  REGIE_CI_WORKSPACE_LEASE_MS,
  REGIE_CI_WORKSPACE_OWNER,
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieCiWorkspaceOwner,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';

export const REGIE_CI_REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
export const REGIE_CI_RUN_PATTERN = /^[a-zA-Z0-9_.:-]+$/;
export const REGIE_CI_JOB_PATTERN = /^[A-Za-z0-9_.:(), -]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRegieCiWorkspaceOwner(
  value: unknown,
): value is RegieCiWorkspaceOwner {
  if (!isRecord(value)) return false;
  const owner = value;

  return (
    typeof owner.repository === 'string' &&
    owner.repository.length <= 201 &&
    REGIE_CI_REPOSITORY_PATTERN.test(owner.repository) &&
    typeof owner.runId === 'string' &&
    owner.runId.length <= 128 &&
    REGIE_CI_RUN_PATTERN.test(owner.runId) &&
    Number.isSafeInteger(owner.runAttempt) &&
    Number(owner.runAttempt) >= 1 &&
    typeof owner.job === 'string' &&
    owner.job.length <= 128 &&
    REGIE_CI_JOB_PATTERN.test(owner.job)
  );
}

export function sameRegieCiWorkspaceOwner(
  left: unknown,
  right: unknown,
): boolean {
  return (
    isRegieCiWorkspaceOwner(left) &&
    isRegieCiWorkspaceOwner(right) &&
    left.repository === right.repository &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.job === right.job
  );
}

export function hasRegieCiWorkspaceMetadata(
  marker: RegieE2eWorkspaceMarker | null | undefined,
): boolean {
  return (
    marker !== undefined &&
    marker !== null &&
    (marker.owner !== undefined ||
      marker.ciOwner !== undefined ||
      marker.issuedAt !== undefined ||
      marker.expiresAt !== undefined)
  );
}

export function isValidRegieCiWorkspaceMarker(
  marker: unknown,
  subdomain: string,
): marker is RegieE2eWorkspaceMarker & { issuedAt: string; expiresAt: string } {
  if (
    !isRecord(marker) ||
    marker.owner !== REGIE_CI_WORKSPACE_OWNER ||
    marker.ephemeral !== true ||
    typeof marker.organizationId !== 'string' ||
    !marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) ||
    marker.workspaceSlug !== subdomain ||
    !subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX) ||
    !isRegieCiWorkspaceOwner(marker.ciOwner) ||
    typeof marker.issuedAt !== 'string' ||
    typeof marker.expiresAt !== 'string'
  )
    return false;

  const issuedAt = Date.parse(marker.issuedAt);
  const expiresAt = Date.parse(marker.expiresAt);

  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    new Date(issuedAt).toISOString() === marker.issuedAt &&
    new Date(expiresAt).toISOString() === marker.expiresAt &&
    expiresAt - issuedAt === REGIE_CI_WORKSPACE_LEASE_MS
  );
}
