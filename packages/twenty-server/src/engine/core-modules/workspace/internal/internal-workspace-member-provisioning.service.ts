import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { isEmail } from 'class-validator';
import { type APP_LOCALES, SOURCE_LOCALE } from 'twenty-shared/translations';
import { isDefined } from 'twenty-shared/utils';
import { Not, QueryFailedError, Raw, type Repository } from 'typeorm';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import { type QueryFailedErrorWithCode } from 'src/engine/api/graphql/workspace-query-runner/utils/workspace-query-runner-graphql-api-exception-handler.util';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import {
  type ProvisionWorkspaceMemberInput,
  type ProvisionWorkspaceMemberResult,
  type UpdateWorkspaceMemberProfileInput,
  type UpdateWorkspaceMemberProfileResult,
  WORKSPACE_MEMBER_PROFILE_POLICIES,
} from 'src/engine/core-modules/workspace/internal/types/internal-workspace-member-provisioning.type';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

@Injectable()
export class InternalWorkspaceMemberProvisioningService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserWorkspaceEntity)
    private readonly userWorkspaceRepository: Repository<UserWorkspaceEntity>,
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async provisionWorkspaceMember(
    input: ProvisionWorkspaceMemberInput,
  ): Promise<ProvisionWorkspaceMemberResult> {
    const email = this.normalizeEmail(input.email);
    const workspace = await this.workspaceRepository.findOneBy({
      id: input.workspaceId,
    });

    if (!isDefined(workspace)) {
      throw new NotFoundException('Workspace not found');
    }

    const user = await this.findOrCreateUser({
      email,
      firstName: input.firstName,
      lastName: input.lastName,
    });
    const userWorkspace = await this.findOrCreateUserWorkspace({
      userId: user.id,
      workspaceId: input.workspaceId,
    });
    const workspaceMember = await this.findOrCreateWorkspaceMember({
      workspaceId: input.workspaceId,
      user,
      userWorkspace,
    });

    return {
      workspaceMemberId: workspaceMember.id,
      userId: user.id,
      appUserId: input.id,
      workspaceId: input.workspaceId,
    };
  }

  async updateWorkspaceMemberProfile(
    input: UpdateWorkspaceMemberProfileInput,
  ): Promise<UpdateWorkspaceMemberProfileResult> {
    const email = this.normalizeEmail(input.email);

    if (!WORKSPACE_MEMBER_PROFILE_POLICIES.includes(input.profilePolicy)) {
      throw new BadRequestException('Invalid profile policy');
    }

    const workspace = await this.workspaceRepository.findOneBy({
      id: input.workspaceId,
    });

    if (!isDefined(workspace)) {
      throw new NotFoundException('Workspace not found');
    }

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      () =>
        this.globalWorkspaceOrmManager.runInWorkspaceTransaction(
          async (transactionScope) => {
            await transactionScope.executeRawQuery(
              `SELECT set_config('lock_timeout', $1, true)`,
              ['5s'],
            );
            // Email has no case-insensitive unique index. Protect the check from all member writers.
            await transactionScope.executeRawQuery(
              `LOCK TABLE ${escapeIdentifier(getWorkspaceSchemaName(input.workspaceId))}."workspaceMember" IN SHARE ROW EXCLUSIVE MODE`,
            );

            const workspaceMemberRepository =
              transactionScope.getRepository<WorkspaceMemberWorkspaceEntity>(
                'workspaceMember',
                { shouldBypassPermissionChecks: true },
              );
            const member = await workspaceMemberRepository.findOne({
              where: { id: input.workspaceMemberId },
            });

            if (!isDefined(member)) {
              throw new NotFoundException('Workspace member not found');
            }

            const result = {
              workspaceMemberId: member.id,
              workspaceId: input.workspaceId,
            };
            const isFillMissing = input.profilePolicy === 'fill_missing';

            // A Go member's email is an identity boundary, not provider profile data.
            if (
              isFillMissing &&
              member.userEmail?.trim().toLowerCase() !== email
            ) {
              return result;
            }

            const conflictingMember = await workspaceMemberRepository.findOne({
              where: {
                id: Not(member.id),
                userEmail: Raw((alias) => `LOWER(BTRIM(${alias})) = :email`, {
                  email,
                }),
              },
              withDeleted: true,
            });

            if (isDefined(conflictingMember)) {
              throw new ConflictException(
                'Workspace member email is linked to a different member',
              );
            }

            const firstName = this.resolveProfileName(
              member.name?.firstName,
              input.firstName,
              isFillMissing,
            );
            const lastName = this.resolveProfileName(
              member.name?.lastName,
              input.lastName,
              isFillMissing,
            );
            const userEmail = isFillMissing ? member.userEmail : email;

            if (
              member.name?.firstName !== firstName ||
              member.name?.lastName !== lastName ||
              member.userEmail !== userEmail
            ) {
              await workspaceMemberRepository.update(
                { id: member.id },
                { name: { firstName, lastName }, userEmail },
              );
            }

            return result;
          },
        ),
      buildSystemAuthContext(input.workspaceId),
    );
  }

  private resolveProfileName(
    currentName: string | undefined,
    incomingName: string,
    isFillMissing: boolean,
  ): string {
    if (isFillMissing && currentName?.trim()) {
      return currentName;
    }

    return incomingName.trim() || currentName || '';
  }

  private normalizeEmail(email: string): string {
    const normalizedEmail =
      typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!isEmail(normalizedEmail)) {
      throw new BadRequestException('Invalid email');
    }

    return normalizedEmail;
  }

  private async findOrCreateUser({
    email,
    firstName,
    lastName,
  }: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<UserEntity> {
    const existingUser = await this.userRepository.findOne({
      where: { email },
    });

    if (isDefined(existingUser)) {
      return existingUser;
    }

    try {
      return await this.userRepository.save(
        this.userRepository.create({
          email,
          firstName: firstName ?? '',
          lastName: lastName ?? '',
          isEmailVerified: true,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const concurrentlyCreatedUser = await this.userRepository.findOne({
        where: { email },
      });

      if (!isDefined(concurrentlyCreatedUser)) {
        throw error;
      }

      return concurrentlyCreatedUser;
    }
  }

  private async findOrCreateUserWorkspace({
    userId,
    workspaceId,
  }: {
    userId: string;
    workspaceId: string;
  }): Promise<UserWorkspaceEntity> {
    const existingUserWorkspace = await this.userWorkspaceRepository.findOne({
      where: { userId, workspaceId },
    });

    if (isDefined(existingUserWorkspace)) {
      return existingUserWorkspace;
    }

    try {
      return await this.userWorkspaceRepository.save(
        this.userWorkspaceRepository.create({
          userId,
          workspaceId,
        }),
      );
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const concurrentlyCreatedUserWorkspace =
        await this.userWorkspaceRepository.findOne({
          where: { userId, workspaceId },
        });

      if (!isDefined(concurrentlyCreatedUserWorkspace)) {
        throw error;
      }

      return concurrentlyCreatedUserWorkspace;
    }
  }

  private async findOrCreateWorkspaceMember({
    workspaceId,
    user,
    userWorkspace,
  }: {
    workspaceId: string;
    user: UserEntity;
    userWorkspace: UserWorkspaceEntity;
  }): Promise<WorkspaceMemberWorkspaceEntity> {
    const authContext = buildSystemAuthContext(workspaceId);

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const workspaceMemberRepository =
          await this.globalWorkspaceOrmManager.getRepository<WorkspaceMemberWorkspaceEntity>(
            workspaceId,
            'workspaceMember',
            { shouldBypassPermissionChecks: true },
          );

        const existingWorkspaceMember =
          await this.findWorkspaceMemberForUserOrThrowOnConflict({
            workspaceMemberRepository,
            user,
          });

        if (isDefined(existingWorkspaceMember)) {
          return existingWorkspaceMember;
        }

        try {
          await workspaceMemberRepository.insert({
            name: {
              firstName: user.firstName,
              lastName: user.lastName,
            },
            colorScheme: 'System',
            userId: user.id,
            userEmail: user.email,
            avatarUrl: userWorkspace.defaultAvatarUrl ?? null,
            locale: (user.locale ?? SOURCE_LOCALE) as keyof typeof APP_LOCALES,
          });
        } catch (error) {
          if (!this.isUniqueViolation(error)) {
            throw error;
          }
        }

        const workspaceMember =
          await this.findWorkspaceMemberForUserOrThrowOnConflict({
            workspaceMemberRepository,
            user,
          });

        if (!isDefined(workspaceMember)) {
          throw new InternalServerErrorException(
            'Workspace member was not created',
          );
        }

        return workspaceMember;
      },
      authContext,
    );
  }

  private async findWorkspaceMemberForUserOrThrowOnConflict({
    workspaceMemberRepository,
    user,
  }: {
    workspaceMemberRepository: WorkspaceRepository<WorkspaceMemberWorkspaceEntity>;
    user: Pick<UserEntity, 'id' | 'email'>;
  }): Promise<WorkspaceMemberWorkspaceEntity | null> {
    const workspaceMemberByEmail = await workspaceMemberRepository.findOne({
      where: { userEmail: user.email },
    });

    if (isDefined(workspaceMemberByEmail)) {
      if (workspaceMemberByEmail.userId !== user.id) {
        throw new ConflictException(
          'Workspace member email is linked to a different user',
        );
      }

      return workspaceMemberByEmail;
    }

    return await workspaceMemberRepository.findOne({
      where: { userId: user.id },
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error as QueryFailedErrorWithCode).code ===
        POSTGRESQL_ERROR_CODES.UNIQUE_VIOLATION
    );
  }
}
