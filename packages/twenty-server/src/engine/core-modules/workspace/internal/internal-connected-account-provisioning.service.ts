import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CalendarChannelSyncStage,
  CalendarChannelVisibility,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type EntityManager, In, Repository } from 'typeorm';

import { CreateCalendarChannelService } from 'src/engine/core-modules/auth/services/create-calendar-channel.service';
import { plaintextStringSchema } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT } from 'src/engine/core-modules/workspace/internal/constants/internal-connected-account-provisioning.constants';
import {
  type AttachConnectedAccountInput,
  type AttachConnectedAccountResult,
  type DetachConnectedAccountResult,
} from 'src/engine/core-modules/workspace/internal/types/internal-connected-account-provisioning.type';
import { buildAttachConnectedAccountLockName } from 'src/engine/core-modules/workspace/internal/utils/build-attach-connected-account-lock-name.util';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { ConnectedAccountTokenEncryptionService } from 'src/engine/metadata-modules/connected-account/services/connected-account-token-encryption.service';

@Injectable()
export class InternalConnectedAccountProvisioningService {
  private readonly logger = new Logger(
    InternalConnectedAccountProvisioningService.name,
  );

  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
    @InjectRepository(CalendarChannelEntity)
    private readonly calendarChannelRepository: Repository<CalendarChannelEntity>,
    private readonly createCalendarChannelService: CreateCalendarChannelService,
    private readonly connectedAccountTokenEncryptionService: ConnectedAccountTokenEncryptionService,
  ) {}

  /**
   * Serialized per mailbox by an advisory lock: attach is driven by a user toggle, so a
   * double-click can arrive twice at once and neither table has a unique constraint.
   *
   * The transaction comes from the repository's own manager — the global workspace
   * datasource resolves entities by string name and throws on a class.
   */
  async attachConnectedAccount(
    input: AttachConnectedAccountInput,
  ): Promise<AttachConnectedAccountResult> {
    await this.assertWorkspaceExists(input.workspaceId);

    const userWorkspaceId = await this.resolveUserWorkspaceId(input);

    return this.connectedAccountRepository.manager.transaction(
      async (transactionManager) => {
        const transactionQueryRunner = transactionManager.queryRunner;

        if (!isDefined(transactionQueryRunner)) {
          throw new InternalServerErrorException(
            'Attaching a connected account requires a transaction-scoped entity manager.',
          );
        }

        await transactionQueryRunner.query(
          ACQUIRE_ATTACH_CONNECTED_ACCOUNT_LOCK_STATEMENT,
          [
            buildAttachConnectedAccountLockName({
              workspaceId: input.workspaceId,
              userWorkspaceId,
              provider: input.provider,
              handle: input.handle,
            }),
          ],
        );

        const { connectedAccount, created: accountCreated } =
          await this.findOrCreateConnectedAccount(
            input,
            userWorkspaceId,
            transactionManager,
          );

        // A plain mailbox connect. Nothing syncs from an account alone: every calendar
        // and messaging job selects on channels.
        if (input.withCalendarChannel === false) {
          return {
            connectedAccountId: connectedAccount.id,
            created: accountCreated,
          };
        }

        const { calendarChannelId, created: channelCreated } =
          await this.findOrCreateCalendarChannel(
            input,
            connectedAccount.id,
            transactionManager,
          );

        return {
          connectedAccountId: connectedAccount.id,
          calendarChannelId,
          created: accountCreated || channelCreated,
        };
      },
    );
  }

  /** Disabled, never deleted: the sync cursor survives so re-enabling is incremental. */
  async detachConnectedAccount({
    workspaceId,
    connectedAccountId,
  }: {
    workspaceId: string;
    connectedAccountId: string;
  }): Promise<DetachConnectedAccountResult> {
    await this.assertWorkspaceExists(workspaceId);

    const calendarChannels = await this.calendarChannelRepository.find({
      where: { connectedAccountId, workspaceId, isSyncEnabled: true },
    });

    if (calendarChannels.length === 0) {
      return { disabledCalendarChannelIds: [] };
    }

    const calendarChannelIds = calendarChannels.map((channel) => channel.id);

    await this.calendarChannelRepository.update(
      { id: In(calendarChannelIds), workspaceId },
      { isSyncEnabled: false },
    );

    this.logger.log(
      `Disabled ${calendarChannelIds.length} calendar channel(s) for connected account ${connectedAccountId} in workspace ${workspaceId}`,
    );

    return { disabledCalendarChannelIds: calendarChannelIds };
  }

  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRepository.findOneBy({
      id: workspaceId,
    });

    if (!isDefined(workspace)) {
      throw new BadRequestException(`Workspace ${workspaceId} not found.`);
    }
  }

  // connectedAccount.userWorkspaceId is NOT NULL, so an account cannot be attached
  // without the member already existing here.
  private async resolveUserWorkspaceId(
    input: AttachConnectedAccountInput,
  ): Promise<string> {
    const user = await this.userRepository.findOneBy({
      email: input.memberEmail,
    });

    if (!isDefined(user)) {
      throw new BadRequestException(
        `No user found for ${input.memberEmail}. Provision the workspace member first.`,
      );
    }

    const userWorkspace = await this.userWorkspaceRepository.findOneBy({
      userId: user.id,
      workspaceId: input.workspaceId,
    });

    if (!isDefined(userWorkspace)) {
      throw new BadRequestException(
        `${input.memberEmail} is not a member of workspace ${input.workspaceId}. Provision the workspace member first.`,
      );
    }

    return userWorkspace.id;
  }

  // Keyed on workspace, member, provider and handle so a retried attach reuses the
  // existing account rather than creating a duplicate.
  private async findOrCreateConnectedAccount(
    input: AttachConnectedAccountInput,
    userWorkspaceId: string,
    transactionManager: EntityManager,
  ): Promise<{ connectedAccount: ConnectedAccountEntity; created: boolean }> {
    const connectedAccountRepository = transactionManager.getRepository(
      ConnectedAccountEntity,
    );

    const existing = await connectedAccountRepository.findOneBy({
      workspaceId: input.workspaceId,
      userWorkspaceId,
      provider: input.provider,
      handle: input.handle,
    });

    // Tokens are encrypted with the workspace's key, exactly as Twenty's own OAuth
    // callback does. From here the account is indistinguishable from a natively
    // connected one and refreshes through the stock path.
    const { encryptedAccessToken, encryptedRefreshToken } =
      this.connectedAccountTokenEncryptionService.encryptTokenPair({
        accessToken: plaintextStringSchema.parse(input.accessToken),
        refreshToken: plaintextStringSchema.parse(input.refreshToken),
        workspaceId: input.workspaceId,
      });

    if (isDefined(existing)) {
      // Re-attaching replaces the stored grant: Regie may have reconnected the mailbox,
      // and the previous tokens could belong to a revoked consent.
      await connectedAccountRepository.update(
        { id: existing.id, workspaceId: input.workspaceId },
        {
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          // Cleared so the next sync refreshes rather than trusting an anchor that
          // belongs to the tokens just replaced.
          lastCredentialsRefreshedAt: null,
          // The failure describes the grant just replaced, as upstream's reconnect does.
          authFailedAt: null,
        },
      );

      const refreshed = await connectedAccountRepository.findOneByOrFail({
        id: existing.id,
        workspaceId: input.workspaceId,
      });

      return { connectedAccount: refreshed, created: false };
    }

    const saved = await connectedAccountRepository.save(
      connectedAccountRepository.create({
        workspaceId: input.workspaceId,
        userWorkspaceId,
        provider: input.provider,
        handle: input.handle,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
      }),
    );

    this.logger.log(
      `Attached connected account ${saved.id} (${input.provider}) in workspace ${input.workspaceId}`,
    );

    return { connectedAccount: saved, created: true };
  }

  private async findOrCreateCalendarChannel(
    input: AttachConnectedAccountInput,
    connectedAccountId: string,
    transactionManager: EntityManager,
  ): Promise<{ calendarChannelId: string; created: boolean }> {
    const calendarChannelRepository = transactionManager.getRepository(
      CalendarChannelEntity,
    );

    const existing = await calendarChannelRepository.findOneBy({
      connectedAccountId,
      workspaceId: input.workspaceId,
    });

    if (isDefined(existing)) {
      // Nothing else revives a FAILED channel: the list-fetch cron wants the pending
      // stage and the relaunch cron takes FAILED_UNKNOWN only. Gated rather than always,
      // because attach runs on every enable and would otherwise wipe the cursor.
      const isFailed = existing.syncStage === CalendarChannelSyncStage.FAILED;

      // Re-enabled, not replaced, so the cursor survives.
      if (!existing.isSyncEnabled || isFailed) {
        await calendarChannelRepository.update(
          { id: existing.id, workspaceId: input.workspaceId },
          {
            isSyncEnabled: true,
            // syncStatus left alone: the next fetch overwrites it, as upstream does.
            ...(isFailed
              ? {
                  syncStage:
                    CalendarChannelSyncStage.CALENDAR_EVENT_LIST_FETCH_PENDING,
                  syncStageStartedAt: null,
                  throttleFailureCount: 0,
                }
              : {}),
          },
        );
      }

      return { calendarChannelId: existing.id, created: false };
    }

    const calendarChannelId =
      await this.createCalendarChannelService.createCalendarChannel({
        workspaceId: input.workspaceId,
        connectedAccountId,
        handle: input.handle,
        // Under METADATA plus an API key, meeting titles come back redacted. Regie is
        // the only frontend and enforces privacy itself.
        calendarVisibility:
          input.calendarVisibility ??
          CalendarChannelVisibility.SHARE_EVERYTHING,
        // Regie owns email. Also starts the channel ready to fetch, not pending config.
        skipMessageChannelConfiguration: true,
        isContactAutoCreationEnabled: false,
        transactionManager,
      });

    return { calendarChannelId, created: true };
  }
}
