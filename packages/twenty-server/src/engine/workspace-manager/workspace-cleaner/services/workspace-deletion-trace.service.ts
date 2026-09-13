import { Injectable, Logger } from '@nestjs/common';

export type WorkspaceDeletionTrace = {
  event:
    | 'workspace_deletion_discovery_started'
    | 'workspace_deletion_discovery_finished'
    | 'workspace_deletion_discovery_failed'
    | 'workspace_deletion_started'
    | 'workspace_deletion_finished'
    | 'workspace_deletion_failed'
    | 'workspace_deletion_phase_started'
    | 'workspace_deletion_phase_finished';
  workspaceId?: string;
  deletionKind?: string;
  phase?: string;
  result?: string;
  attempt?: number;
  candidates?: number;
  recovered?: number;
  admitted?: number;
  errorCode?: string;
  errorMessage?: string;
};

@Injectable()
export class WorkspaceDeletionTraceService {
  private readonly logger = new Logger(WorkspaceDeletionTraceService.name);

  record(trace: WorkspaceDeletionTrace): void {
    const serializedTrace = JSON.stringify(trace);

    if (trace.event.endsWith('_failed')) {
      this.logger.error(serializedTrace);

      return;
    }

    this.logger.log(serializedTrace);
  }
}
