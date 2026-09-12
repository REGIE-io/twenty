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

export async function withWorkspaceDeletionDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: WorkspaceDeletionTimeoutCode,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new WorkspaceDeletionTimeoutError(code, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
