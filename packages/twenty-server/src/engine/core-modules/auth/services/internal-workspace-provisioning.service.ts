import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ApiKeyService } from 'src/engine/core-modules/api-key/services/api-key.service';
import {
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_E2E_PURGE_GRACE_PERIOD_MS,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { KeyValuePairType } from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { KeyValuePairService } from 'src/engine/core-modules/key-value-pair/key-value-pair.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { fromUserEntityToFlat } from 'src/engine/core-modules/user/utils/from-user-entity-to-flat.util';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

const DEFAULT_SERVICE_USER_EMAIL = 'twenty-workspace-provisioning@regie.ai';

type CreateWorkspaceInput = {
  name?: string;
  slug?: string;
  primaryDomain?: string;
  serviceUserEmail?: string;
  ephemeral?: boolean;
  organizationId?: string;
};

type RegieWorkspaceMarkerMap = {
  [REGIE_E2E_WORKSPACE_MARKER_KEY]: RegieE2eWorkspaceMarker;
};

type CreateWorkspaceApiKeyInput = {
  name?: string;
  expiresAt?: string;
};

@Injectable()
export class InternalWorkspaceProvisioningService {
  constructor(
    private readonly signInUpService: SignInUpService,
    private readonly userService: UserService,
    private readonly workspaceService: WorkspaceService,
    private readonly apiKeyService: ApiKeyService,
    private readonly keyValuePairService: KeyValuePairService<RegieWorkspaceMarkerMap>,
  ) {}

  async createWorkspace(input: CreateWorkspaceInput) {
    const displayName = this.requiredTrimmed(input.name, 'name');
    const subdomain = this.requiredTrimmed(input.slug, 'slug');
    const e2eMarker = this.buildE2eMarker(input, subdomain);
    const serviceUserEmail = this.getServiceUserEmail(input.serviceUserEmail);
    const existingUser =
      await this.userService.findUserByEmail(serviceUserEmail);

    const result = await this.signInUpService.signUpOnNewWorkspace(
      existingUser
        ? { type: 'existingUser', existingUser }
        : {
            type: 'newUserWithPicture',
            newUserWithPicture: {
              email: serviceUserEmail,
              firstName: 'Regie',
              lastName: 'Provisioning',
              isEmailVerified: true,
            },
          },
      {
        displayName,
        subdomain,
        shouldBypassWorkspaceCreationChecks: true,
        // Internal service-to-service provisioning has no human accepting the click-through DPA.
        shouldRecordDpaAcceptance: false,
      },
    );
    if (e2eMarker) {
      await this.keyValuePairService.set({
        workspaceId: result.workspace.id,
        key: REGIE_E2E_WORKSPACE_MARKER_KEY,
        value: e2eMarker,
        type: KeyValuePairType.USER_VARIABLE,
      });
    }

    const workspace =
      (await this.workspaceService.activateWorkspace(
        fromUserEntityToFlat(result.user),
        result.workspace,
      )) ?? result.workspace;

    return this.toWorkspaceProvisioningResponse(workspace, input.primaryDomain);
  }

  async activateWorkspace(workspaceId: string) {
    const serviceUserEmail = this.getServiceUserEmail();
    const user = await this.userService.findUserByEmail(serviceUserEmail);
    const workspace =
      await this.workspaceService.findOneWorkspaceById(workspaceId);

    if (!user) {
      throw new NotFoundException('Workspace provisioning user was not found');
    }

    if (!workspace) {
      throw new NotFoundException('Workspace was not found');
    }

    const activatedWorkspace =
      (await this.workspaceService.activateWorkspace(
        fromUserEntityToFlat(user),
        workspace,
      )) ?? workspace;

    return this.toWorkspaceProvisioningResponse(activatedWorkspace);
  }

  async createWorkspaceApiKey(
    workspaceId: string,
    input: CreateWorkspaceApiKeyInput,
  ) {
    const workspace =
      await this.workspaceService.findOneWorkspaceById(workspaceId);

    if (!workspace) {
      throw new NotFoundException('Workspace was not found');
    }

    const apiKey = await this.apiKeyService.createWorkspaceAdminApiKeyToken({
      workspaceId,
      name: input.name?.trim() || 'regie-crm-api',
      expiresAt: input.expiresAt,
    });

    return {
      ok: true,
      workspaceId,
      apiKey: apiKey.token,
      apiKeyId: apiKey.apiKeyId,
    };
  }

  async deleteWorkspace(workspaceId: string) {
    const workspace =
      await this.workspaceService.findOneWorkspaceByIdIncludingDeleted(
        workspaceId,
      );

    if (!workspace) {
      return {
        ok: true,
        id: workspaceId,
        workspaceId,
        deleted: false,
        quarantined: false,
        purgeEligible: false,
      };
    }

    const alreadyQuarantined = Boolean(workspace.deletedAt);
    const quarantinedAt = workspace.deletedAt ?? new Date();
    const purgeEligible = await this.hasValidE2eWorkspaceMarker(workspace);

    // Re-run the soft-delete path for an existing tombstone too: older callers may
    // have set deletedAt without flushing the workspace metadata caches.
    await this.workspaceService.deleteWorkspace(workspaceId, true);

    return {
      ok: true,
      id: workspace.id,
      workspaceId: workspace.id,
      deleted: !alreadyQuarantined,
      quarantined: true,
      purgeEligible,
      ...(purgeEligible
        ? {
            purgeAfter: new Date(
              quarantinedAt.getTime() + REGIE_E2E_PURGE_GRACE_PERIOD_MS,
            ).toISOString(),
          }
        : {}),
    };
  }

  private buildE2eMarker(
    input: CreateWorkspaceInput,
    workspaceSlug: string,
  ): RegieE2eWorkspaceMarker | undefined {
    if (input.ephemeral !== true) {
      if (input.organizationId !== undefined) {
        throw new BadRequestException(
          'organizationId is only accepted for ephemeral workspaces',
        );
      }

      return undefined;
    }

    const organizationId = this.requiredTrimmed(
      input.organizationId,
      'organizationId',
    );

    if (
      !organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) ||
      !workspaceSlug.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX)
    ) {
      throw new BadRequestException(
        'Ephemeral workspaces require an org_e2e_* organization and org-e2e-* slug',
      );
    }

    return { ephemeral: true, organizationId, workspaceSlug };
  }

  private async hasValidE2eWorkspaceMarker(workspace: WorkspaceEntity) {
    const [markerEntry] = await this.keyValuePairService.get({
      workspaceId: workspace.id,
      key: REGIE_E2E_WORKSPACE_MARKER_KEY,
      type: KeyValuePairType.USER_VARIABLE,
    });
    const marker = (
      markerEntry as unknown as { value?: RegieE2eWorkspaceMarker } | undefined
    )?.value;

    return !(
      marker?.ephemeral !== true ||
      typeof marker.organizationId !== 'string' ||
      !marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) ||
      typeof marker.workspaceSlug !== 'string' ||
      marker.workspaceSlug !== workspace.subdomain ||
      !workspace.subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX)
    );
  }

  private getServiceUserEmail(email?: string): string {
    return (
      email?.trim().toLowerCase() ||
      process.env.REGIE_WORKSPACE_PROVISIONING_USER_EMAIL ||
      DEFAULT_SERVICE_USER_EMAIL
    );
  }

  private requiredTrimmed(value: string | undefined, field: string): string {
    const trimmedValue = value?.trim();

    if (!trimmedValue) {
      throw new BadRequestException(`Request body must include ${field}`);
    }

    return trimmedValue;
  }

  private toWorkspaceProvisioningResponse(
    workspace: WorkspaceEntity,
    primaryDomain?: string,
  ) {
    const workspaceUrl =
      primaryDomain ??
      (process.env.FRONT_BASE_URL
        ? `https://${workspace.subdomain}.${new URL(process.env.FRONT_BASE_URL).hostname}`
        : undefined);

    return {
      ok: true,
      id: workspace.id,
      workspaceId: workspace.id,
      workspaceUrl,
      workspaceName: workspace.displayName,
      workspaceSubdomain: workspace.subdomain,
    };
  }
}
