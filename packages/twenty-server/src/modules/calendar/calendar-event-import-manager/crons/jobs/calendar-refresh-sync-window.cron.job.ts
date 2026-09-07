import { InjectRepository } from '@nestjs/typeorm';

import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { Repository } from 'typeorm';

import { SentryCronMonitor } from 'src/engine/core-modules/cron/sentry-cron-monitor.decorator';
import { ExceptionHandlerService } from 'src/engine/core-modules/exception-handler/exception-handler.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { CalendarChannelSyncStatusService } from 'src/modules/calendar/common/services/calendar-channel-sync-status.service';

export const CALENDAR_REFRESH_SYNC_WINDOW_CRON_PATTERN = '0 3 * * *';

@Processor(MessageQueue.cronQueue)
export class CalendarRefreshSyncWindowCronJob {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly calendarChannelSyncStatusService: CalendarChannelSyncStatusService,
    private readonly exceptionHandlerService: ExceptionHandlerService,
  ) {}

  @Process(CalendarRefreshSyncWindowCronJob.name)
  @SentryCronMonitor(
    CalendarRefreshSyncWindowCronJob.name,
    CALENDAR_REFRESH_SYNC_WINDOW_CRON_PATTERN,
  )
  async handle(): Promise<void> {
    const activeWorkspaces = await this.workspaceRepository.find({
      where: { activationStatus: WorkspaceActivationStatus.ACTIVE },
      select: { id: true },
    });

    const activeWorkspaceIds = activeWorkspaces.map(
      (workspace) => workspace.id,
    );

    if (activeWorkspaceIds.length === 0) {
      return;
    }
    const channelsDue = await this.calendarChannelRepository
      .createQueryBuilder('calendarChannel')
      .select(['calendarChannel.id', 'calendarChannel.workspaceId'])
      .where('calendarChannel.workspaceId IN (:...activeWorkspaceIds)', {
        activeWorkspaceIds,
      })
      .andWhere('calendarChannel.isSyncEnabled = true')
      .andWhere("calendarChannel.syncCursor <> ''")
      .andWhere(
        'EXTRACT(DAY FROM calendarChannel."createdAt") = EXTRACT(DAY FROM now())',
      )
      .getMany()
      .catch((error) => {
        this.exceptionHandlerService.captureExceptions([error]);

        return [];
      });

    const channelIdsByWorkspaceId = new Map<string, string[]>();

    for (const channel of channelsDue) {
      const existing = channelIdsByWorkspaceId.get(channel.workspaceId) ?? [];

      channelIdsByWorkspaceId.set(channel.workspaceId, [
        ...existing,
        channel.id,
      ]);
    }

    for (const [workspaceId, calendarChannelIds] of channelIdsByWorkspaceId) {
      try {
        await this.calendarChannelSyncStatusService.resetAndMarkAsCalendarEventListFetchPending(
          calendarChannelIds,
          workspaceId,
        );
      } catch (error) {
        this.exceptionHandlerService.captureExceptions([error], {
          workspace: { id: workspaceId },
        });
      }
    }
  }
}
