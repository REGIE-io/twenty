import { Logger } from '@nestjs/common';

import {
  type WorkspaceDeletionTrace,
  WorkspaceDeletionTraceService,
} from 'src/engine/workspace-manager/workspace-cleaner/services/workspace-deletion-trace.service';

describe('WorkspaceDeletionTraceService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes lifecycle events as structured JSON with workspace identity in the log, not metric dimensions', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const trace = new WorkspaceDeletionTraceService();

    trace.record({
      event: 'workspace_deletion_started',
      workspaceId: '20202020-0000-4000-8000-000000000001',
    });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'workspace_deletion_started',
        workspaceId: '20202020-0000-4000-8000-000000000001',
      }),
    );
  });

  it('writes failed lifecycle events at error level with actionable context', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const trace = new WorkspaceDeletionTraceService();
    const failedTrace = {
      event: 'workspace_deletion_failed',
      workspaceId: '20202020-0000-4000-8000-000000000001',
      deletionKind: 'E2E',
      phase: 'SCHEMA',
      attempt: 3,
      result: 'terminal-failure',
      errorCode: '55P03',
      errorMessage: 'schema lock timeout',
    } as unknown as WorkspaceDeletionTrace;

    trace.record(failedTrace);

    expect(error).toHaveBeenCalledWith(JSON.stringify(failedTrace));
  });
});
