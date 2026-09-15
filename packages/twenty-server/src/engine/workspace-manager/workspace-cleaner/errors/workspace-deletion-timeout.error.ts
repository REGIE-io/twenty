export type WorkspaceDeletionTimeoutCode =
  | 'WORKSPACE_DELETION_PHASE_TIMEOUT'
  | 'WORKSPACE_DELETION_JOB_TIMEOUT';

export class WorkspaceDeletionTimeoutError extends Error {
  constructor(
    public readonly code: WorkspaceDeletionTimeoutCode,
    timeoutMs: number,
  ) {
    super(`${code} after ${timeoutMs}ms`);
    this.name = 'WorkspaceDeletionTimeoutError';
  }
}

// A JavaScript promise cannot be cancelled safely. Keep awaiting the operation
// after its deadline so callers retain their workspace lock, then surface the
// timeout once no work can still be running in the background.
export async function withWorkspaceDeletionDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: WorkspaceDeletionTimeoutCode,
): Promise<T> {
  let deadlineExceeded = false;
  const timeout = setTimeout(() => {
    deadlineExceeded = true;
  }, timeoutMs);

  try {
    const result = await operation;

    if (deadlineExceeded) {
      throw new WorkspaceDeletionTimeoutError(code, timeoutMs);
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}
