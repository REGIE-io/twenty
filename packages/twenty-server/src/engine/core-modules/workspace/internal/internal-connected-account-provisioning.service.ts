import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CalendarChannelVisibility } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { In, Repository } from 'typeorm';

import { CreateCalendarChannelService } from 'src/engine/core-modules/auth/services/create-calendar-channel.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import {
  type AttachConnectedAccountInput,
  type AttachConnectedAccountResult,
  type DetachConnectedAccountResult,
} from 'src/engine/core-modules/workspace/internal/types/internal-connected-account-provisioning.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { CalendarChannelEntity } from 'src/engine/metadata-modules/calendar-channel/entities/calendar-channel.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { ConnectedAccountRefreshTokensService } from 'src/modules/connected-account/refresh-tokens-manager/services/connected-account-refresh-tokens.service';
import { REGIE_MAILBOX_ID_PARAMETER_KEY } from 'src/modules/connected-account/token-delegation/utils/get-delegated-mailbox-id.util';

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
    private readonly connectedAccountRefreshTokensService: ConnectedAccountRefreshTokensService,
  ) {}

  /**
   * Records a Regie-owned mailbox here and gives it a calendar channel.
   *
   * Not transactional by design: the delegation check in the middle is an HTTP call to
   * Regie that itself writes, and holding a transaction open across it would trade a
   * harmless orphan record for real lock contention. A failed check leaves a connected
   * account with no channel, which is inert — every sync job selects on channels — and
   * the next attach reuses it.
   */
  async attachConnectedAccount(
    input: AttachConnectedAccountInput,
  ): Promise<AttachConnectedAccountResult> {
    await this.assertWorkspaceExists(input.workspaceId);

    const userWorkspaceId = await this.resolveUserWorkspaceId(input);

    const { connectedAccount, created: accountCreated } =
      await this.findOrCreateConnectedAccount(input, userWorkspaceId);

    if (input.verifyTokenDelegation !== false) {
      await this.verifyTokenDelegation(connectedAccount, input.workspaceId);
    }

    const { calendarChannelId, created: channelCreated } =
      await this.findOrCreateCalendarChannel(input, connectedAccount.id);

    return {
      connectedAccountId: connectedAccount.id,
      calendarChannelId,
      created: accountCreated || channelCreated,
    };
  }

  /**
   * Stops Twenty syncing an account's calendars.
   *
   * Channels are disabled, never deleted: the sync cursor survives so re-enabling is
   * incremental rather than a full recrawl, and already-synced meetings stay attributable
   * to the channel they came from.
   */
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
  ): Promise<{ connectedAccount: ConnectedAccountEntity; created: boolean }> {
    const existing = await this.connectedAccountRepository.findOneBy({
      workspaceId: input.workspaceId,
      userWorkspaceId,
      provider: input.provider,
      handle: input.handle,
    });

    if (isDefined(existing)) {
      // Marking an account delegated must also revoke Twenty's ability to act on its
      // own. An account connected through Twenty's OAuth keeps a usable refresh token,
      // and the Google client would take that branch and refresh independently — the
      // double-refresh delegation exists to prevent. Clearing the anchor forces the
      // first delegated resolution now rather than up to an hour from now.
      await this.connectedAccountRepository.update(
        { id: existing.id, workspaceId: input.workspaceId },
        {
          connectionParameters: {
            ...(existing.connectionParameters ?? {}),
            [REGIE_MAILBOX_ID_PARAMETER_KEY]: input.regieMailboxId,
          },
          accessToken: null,
          refreshToken: null,
          lastCredentialsRefreshedAt: null,
        },
      );

      // Re-read so the delegation check below sees the marker just written.
      const refreshed = await this.connectedAccountRepository.findOneByOrFail({
        id: existing.id,
      });

      return { connectedAccount: refreshed, created: false };
    }

    const saved = await this.connectedAccountRepository.save(
      this.connectedAccountRepository.create({
        workspaceId: input.workspaceId,
        userWorkspaceId,
        provider: input.provider,
        handle: input.handle,
        accessToken: null,
        refreshToken: null,
        connectionParameters: {
          [REGIE_MAILBOX_ID_PARAMETER_KEY]: input.regieMailboxId,
        },
      }),
    );

    this.logger.log(
      `Attached delegated connected account ${saved.id} (${input.provider}) in workspace ${input.workspaceId}`,
    );

    return { connectedAccount: saved, created: true };
  }

  private async findOrCreateCalendarChannel(
    input: AttachConnectedAccountInput,
    connectedAccountId: string,
  ): Promise<{ calendarChannelId: string; created: boolean }> {
    const existing = await this.calendarChannelRepository.findOneBy({
      connectedAccountId,
      workspaceId: input.workspaceId,
    });

    if (isDefined(existing)) {
      // Re-enabled rather than replaced, so the stored sync cursor survives and turning
      // sync back on does not force a full resync.
      if (!existing.isSyncEnabled) {
        await this.calendarChannelRepository.update(
          { id: existing.id, workspaceId: input.workspaceId },
          { isSyncEnabled: true },
        );
      }

      return { calendarChannelId: existing.id, created: false };
    }

    // The transaction has to come from the repository's own manager. calendarChannel is
    // a core entity, and the global workspace datasource resolves workspace entities by
    // string name — handing it a class throws "Entity target must be a string".
    const calendarChannelId =
      await this.calendarChannelRepository.manager.transaction(
        async (transactionManager) =>
          this.createCalendarChannelService.createCalendarChannel({
            workspaceId: input.workspaceId,
            connectedAccountId,
            handle: input.handle,
            // Twenty's visibility model assumes Twenty is the frontend: under METADATA
            // plus an API key, a user's own meeting titles come back redacted. Regie is
            // the only frontend and enforces privacy itself.
            calendarVisibility:
              input.calendarVisibility ??
              CalendarChannelVisibility.SHARE_EVERYTHING,
            // Regie owns email, so no message channel is configured. That also starts the
            // channel ready to fetch rather than pending configuration.
            skipMessageChannelConfiguration: true,
            transactionManager,
          }),
      );

    return { calendarChannelId, created: true };
  }

  // Resolving tokens exercises the whole handshake: the secret, reachability, the
  // mailbox existing on Regie's side, and the grant still being alive.
  private async verifyTokenDelegation(
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
  ): Promise<void> {
    try {
      await this.connectedAccountRefreshTokensService.resolveTokens(
        connectedAccount,
        workspaceId,
      );
    } catch (error) {
      throw new BadRequestException(
        `Token delegation check failed for ${connectedAccount.handle} (mailbox ${connectedAccount.connectionParameters?.[REGIE_MAILBOX_ID_PARAMETER_KEY]}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
