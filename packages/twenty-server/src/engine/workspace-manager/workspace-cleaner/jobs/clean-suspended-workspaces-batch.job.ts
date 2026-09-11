import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { subDays } from 'date-fns';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { IsNull, LessThan, Repository } from 'typeorm';

import { PostgresAdvisoryLockService } from 'src/database/typeorm/postgres-advisory-lock.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CleanerWorkspaceService } from 'src/engine/workspace-manager/workspace-cleaner/services/cleaner.workspace-service';
import { RegieE2eWorkspaceSweeperService } from 'src/engine/workspace-manager/workspace-cleaner/services/regie-e2e-workspace-sweeper.service';

const CLEAN_SUSPENDED_WORKSPACES_LOCK_NAME = 'clean-suspended-workspaces-job';

@Processor(MessageQueue.workspaceCleanupQueue)
export class CleanSuspendedWorkspacesBatchJob {
  private readonly logger = new Logger(CleanSuspendedWorkspacesBatchJob.name);

  constructor(
    private readonly cleanerWorkspaceService: CleanerWorkspaceService,
    private readonly regieE2eWorkspaceSweeperService: RegieE2eWorkspaceSweeperService,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    private readonly twentyConfigService: TwentyConfigService,
    private readonly postgresAdvisoryLockService: PostgresAdvisoryLockService,
  ) {}

  @Process(CleanSuspendedWorkspacesBatchJob.name)
  async handle(): Promise<void> {
    const result = await this.postgresAdvisoryLockService.tryWithLock(
      CLEAN_SUSPENDED_WORKSPACES_LOCK_NAME,
      async () => {
        const workspaceIds = await this.findCleanupCandidateIds();

        this.logger.log(
          `Selected ${workspaceIds.length} suspended workspace cleanup candidates`,
        );

        await this.cleanerWorkspaceService.batchWarnOrCleanSuspendedWorkspaces({
          workspaceIds,
        });
        await this.regieE2eWorkspaceSweeperService.purgeQuarantinedWorkspaces();
      },
    );

    if (!result.acquired) {
      this.logger.log(
        'Skipping suspended workspace cleanup because another execution is running',
      );
    }
  }

  private async findCleanupCandidateIds(now = new Date()): Promise<string[]> {
    const inactiveDaysBeforeWarn = this.twentyConfigService.get(
      'WORKSPACE_INACTIVE_DAYS_BEFORE_NOTIFICATION',
    );
    const inactiveDaysBeforeSoftDelete = this.twentyConfigService.get(
      'WORKSPACE_INACTIVE_DAYS_BEFORE_SOFT_DELETION',
    );
    const inactiveDaysBeforeDelete = this.twentyConfigService.get(
      'WORKSPACE_INACTIVE_DAYS_BEFORE_DELETION',
    );
    const deletionLimit = this.twentyConfigService.get(
      'MAX_NUMBER_OF_WORKSPACES_DELETED_PER_EXECUTION',
    );
    const hardDeletionGracePeriod =
      inactiveDaysBeforeDelete - inactiveDaysBeforeSoftDelete;

    const [hardDeleteCandidates, activeCandidates] = await Promise.all([
      this.workspaceRepository.find({
        select: ['id'],
        where: {
          activationStatus: WorkspaceActivationStatus.SUSPENDED,
          deletedAt: LessThan(subDays(now, hardDeletionGracePeriod)),
        },
        order: { deletedAt: 'ASC', id: 'ASC' },
        take: deletionLimit,
        withDeleted: true,
      }),
      this.workspaceRepository.find({
        select: ['id'],
        where: {
          activationStatus: WorkspaceActivationStatus.SUSPENDED,
          deletedAt: IsNull(),
          suspendedAt: LessThan(subDays(now, inactiveDaysBeforeWarn)),
        },
        order: { suspendedAt: 'ASC', id: 'ASC' },
        withDeleted: true,
      }),
    ]);

    return [...hardDeleteCandidates, ...activeCandidates].map(
      (workspace) => workspace.id,
    );
  }
}
