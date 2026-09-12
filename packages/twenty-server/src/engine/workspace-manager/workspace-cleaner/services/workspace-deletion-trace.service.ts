import { Injectable, Logger } from '@nestjs/common';

export type WorkspaceDeletionTrace = {
  event:
    | 'workspace_deletion_started'
    | 'workspace_deletion_finished'
    | 'workspace_deletion_phase_started'
    | 'workspace_deletion_phase_finished';
  workspaceId: string;
  phase?: string;
  result?: string;
};

@Injectable()
export class WorkspaceDeletionTraceService {
  private readonly logger = new Logger(WorkspaceDeletionTraceService.name);

  record(trace: WorkspaceDeletionTrace): void {
    this.logger.log(JSON.stringify(trace));
  }
}
