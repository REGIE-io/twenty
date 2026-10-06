import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  ConnectedAccountProvider,
  MessageChannelPendingGroupEmailsAction,
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  MessageChannelType,
  MessageChannelVisibility,
} from 'twenty-shared/types';
import { WorkspaceActivationStatus } from 'twenty-shared/workspace';
import { IsNull, Repository } from 'typeorm';

import { REGIE_E2E_WORKSPACE_MARKER_KEY } from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  isValidRegieCiWorkspaceMarker,
  sameRegieCiWorkspaceOwner,
} from 'src/engine/core-modules/auth/utils/regie-ci-workspace-marker.util';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { type ProvisionE2eMessageChannelDto } from 'src/engine/core-modules/workspace/internal/dtos/provision-e2e-message-channel.dto';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import { MessageChannelEntity } from 'src/engine/metadata-modules/message-channel/entities/message-channel.entity';

@Injectable()
export class InternalE2eMessageChannelService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
  ) {}

  async provision(workspaceId: string, input: ProvisionE2eMessageChannelDto) {
    return this.workspaces.manager.transaction(async (manager) => {
      // Lock the owned workspace before the mailbox lookup so retries cannot create duplicate channels.
      const workspace = await manager.getRepository(WorkspaceEntity).findOne({
        where: { id: workspaceId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      const markerRow = await manager
        .getRepository(KeyValuePairEntity)
        .findOne({
          where: {
            workspaceId,
            key: REGIE_E2E_WORKSPACE_MARKER_KEY,
            type: KeyValuePairType.USER_VARIABLE,
            userId: IsNull(),
            applicationId: IsNull(),
            deletedAt: IsNull(),
          },
          lock: { mode: 'pessimistic_read' },
        });
      const marker: unknown = markerRow?.value;
      if (
        !workspace ||
        workspace.activationStatus !== WorkspaceActivationStatus.ACTIVE ||
        !isValidRegieCiWorkspaceMarker(marker, workspace.subdomain) ||
        input.ciOwner?.repository !== 'REGIE-io/go' ||
        !sameRegieCiWorkspaceOwner(marker.ciOwner, input.ciOwner) ||
        Date.parse(marker.issuedAt) > Date.now() ||
        Date.parse(marker.expiresAt) <= Date.now()
      ) {
        throw new BadRequestException(
          'An active, unexpired CI workspace and its exact recorded owner are required.',
        );
      }
      const user = await manager
        .getRepository(UserEntity)
        .findOneBy({ email: input.memberEmail, deletedAt: IsNull() });
      const member = user
        ? await manager
            .getRepository(UserWorkspaceEntity)
            .findOneBy({ userId: user.id, workspaceId, deletedAt: IsNull() })
        : null;
      if (!member) {
        throw new BadRequestException(
          'The fixture member must already belong to this workspace.',
        );
      }

      const accounts = manager.getRepository(ConnectedAccountEntity);
      let account = await accounts.findOneBy({
        workspaceId,
        userWorkspaceId: member.id,
        provider: ConnectedAccountProvider.GOOGLE,
        handle: input.handle,
      });
      if (
        account &&
        (account.accessToken !== null ||
          account.refreshToken !== null ||
          account.connectionParameters !== null ||
          account.archivedAt !== null)
      ) {
        throw new BadRequestException(
          'An existing connected account cannot be converted into a CI fixture.',
        );
      }
      const channels = manager.getRepository(MessageChannelEntity);
      const existing = account
        ? await channels.findOneBy({
            workspaceId,
            connectedAccountId: account.id,
            type: MessageChannelType.EMAIL,
          })
        : null;
      if (existing) {
        if (
          existing.handle !== input.handle ||
          existing.isSyncEnabled ||
          existing.visibility !== MessageChannelVisibility.SHARE_EVERYTHING ||
          existing.syncStage !==
            MessageChannelSyncStage.PENDING_CONFIGURATION ||
          existing.syncStatus !== MessageChannelSyncStatus.NOT_SYNCED ||
          existing.pendingGroupEmailsAction !==
            MessageChannelPendingGroupEmailsAction.NONE ||
          existing.isContactAutoCreationEnabled
        ) {
          throw new BadRequestException(
            'An existing message channel cannot be converted into a CI fixture.',
          );
        }
        return {
          connectedAccountId: existing.connectedAccountId,
          messageChannelId: existing.id,
          created: false,
        };
      }
      if (!account) {
        account = await accounts.save(
          accounts.create({
            workspaceId,
            userWorkspaceId: member.id,
            provider: ConnectedAccountProvider.GOOGLE,
            handle: input.handle,
            accessToken: null,
            refreshToken: null,
            connectionParameters: null,
            scopes: [],
            visibility: 'user',
          }),
        );
      }
      // Creating the rows directly avoids OAuth/token refresh and native channel scheduling.
      const channel = await channels.save(
        channels.create({
          workspaceId,
          connectedAccountId: account.id,
          handle: input.handle,
          type: MessageChannelType.EMAIL,
          visibility: MessageChannelVisibility.SHARE_EVERYTHING,
          isSyncEnabled: false,
          isContactAutoCreationEnabled: false,
          syncStage: MessageChannelSyncStage.PENDING_CONFIGURATION,
          syncStatus: MessageChannelSyncStatus.NOT_SYNCED,
          pendingGroupEmailsAction: MessageChannelPendingGroupEmailsAction.NONE,
        }),
      );
      return {
        connectedAccountId: account.id,
        messageChannelId: channel.id,
        created: true,
      };
    });
  }
}
