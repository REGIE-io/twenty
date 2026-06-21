import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { ApiKeyService } from 'src/engine/core-modules/api-key/services/api-key.service';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

type InternalWorkspaceProvisioningBody = {
  name?: string;
  slug?: string;
  primaryDomain?: string;
  serviceUserEmail?: string;
};

type InternalWorkspaceApiKeyBody = {
  name?: string;
  expiresAt?: string;
};

@Controller('internal/workspaces')
export class InternalWorkspaceProvisioningController {
  constructor(
    private readonly signInUpService: SignInUpService,
    private readonly userService: UserService,
    private readonly workspaceService: WorkspaceService,
    private readonly apiKeyService: ApiKeyService,
  ) {}

  @Post()
  async createWorkspace(
    @Headers('x-internal-token') internalToken: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
    @Body() body: InternalWorkspaceProvisioningBody,
  ) {
    const expectedToken =
      process.env.REGIE_INTERNAL_METADATA_TOKEN ??
      process.env.TWENTY_INTERNAL_METADATA_TOKEN;

    if (!expectedToken) {
      throw new InternalServerErrorException(
        'Internal workspace provisioning token is not configured',
      );
    }

    const actualHeader = Array.isArray(internalToken)
      ? internalToken[0]
      : internalToken;
    const actualBearer = readBearerToken(authorization);
    const actualToken = actualHeader ?? actualBearer;

    if (actualToken !== expectedToken) {
      throw new UnauthorizedException('Invalid internal workspace token');
    }

    const displayName = body.name?.trim();
    const subdomain = body.slug?.trim();

    if (!displayName || !subdomain) {
      throw new BadRequestException('Request body must include name and slug');
    }

    const serviceUserEmail =
      body.serviceUserEmail?.trim() ??
      process.env.REGIE_WORKSPACE_PROVISIONING_USER_EMAIL ??
      'twenty-workspace-provisioning@regie.ai';
    const existingUser = await this.userService.findUserByEmail(serviceUserEmail);
    const result = await this.signInUpService.signUpOnNewWorkspace(
      existingUser
        ? { type: 'existingUser', existingUser }
        : {
            type: 'newUserWithPicture',
            newUserWithPicture: {
              email: serviceUserEmail,
              firstName: 'Regie',
              lastName: 'Provisioning',
              isEmailAlreadyVerified: true,
            },
          },
      { displayName, subdomain },
    );
    const workspace =
      (await this.workspaceService.activateWorkspace(
        result.user,
        result.workspace,
      )) ?? result.workspace;
    const workspaceUrl =
      body.primaryDomain ??
      (process.env.FRONT_BASE_URL
        ? `https://${subdomain}.${new URL(process.env.FRONT_BASE_URL).hostname}`
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

  @Post(':workspaceId/activate')
  async activateWorkspace(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-token') internalToken: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
  ) {
    const expectedToken =
      process.env.REGIE_INTERNAL_METADATA_TOKEN ??
      process.env.TWENTY_INTERNAL_METADATA_TOKEN;

    if (!expectedToken) {
      throw new InternalServerErrorException(
        'Internal workspace provisioning token is not configured',
      );
    }

    const actualHeader = Array.isArray(internalToken)
      ? internalToken[0]
      : internalToken;
    const actualBearer = readBearerToken(authorization);
    const actualToken = actualHeader ?? actualBearer;

    if (actualToken !== expectedToken) {
      throw new UnauthorizedException('Invalid internal workspace token');
    }

    const serviceUserEmail =
      process.env.REGIE_WORKSPACE_PROVISIONING_USER_EMAIL ??
      'twenty-workspace-provisioning@regie.ai';
    const user = await this.userService.findUserByEmail(serviceUserEmail);
    const workspace = await this.workspaceService.findOneWorkspaceById(workspaceId);

    if (!user) {
      throw new NotFoundException('Workspace provisioning user was not found');
    }

    if (!workspace) {
      throw new NotFoundException('Workspace was not found');
    }

    const activatedWorkspace =
      (await this.workspaceService.activateWorkspace(user, workspace)) ??
      workspace;

    return {
      ok: true,
      id: activatedWorkspace.id,
      workspaceId: activatedWorkspace.id,
      workspaceName: activatedWorkspace.displayName,
      workspaceSubdomain: activatedWorkspace.subdomain,
    };
  }

  @Post(':workspaceId/api-keys')
  async createWorkspaceApiKey(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-internal-token') internalToken: string | string[] | undefined,
    @Headers('authorization') authorization: string | string[] | undefined,
    @Body() body: InternalWorkspaceApiKeyBody,
  ) {
    assertInternalToken(internalToken, authorization);

    const name = body.name?.trim() || 'regie-crm-api';
    const workspace = await this.workspaceService.findOneWorkspaceById(workspaceId);

    if (!workspace) {
      throw new NotFoundException('Workspace was not found');
    }

    const apiKey = await this.apiKeyService.createWorkspaceAdminApiKeyToken({
      workspaceId,
      name,
      expiresAt: body.expiresAt,
    });

    return {
      ok: true,
      workspaceId,
      apiKey: apiKey.token,
      apiKeyId: apiKey.apiKeyId,
    };
  }
}

function assertInternalToken(
  internalToken: string | string[] | undefined,
  authorization: string | string[] | undefined,
) {
  const expectedToken =
    process.env.REGIE_INTERNAL_METADATA_TOKEN ??
    process.env.TWENTY_INTERNAL_METADATA_TOKEN;

  if (!expectedToken) {
    throw new InternalServerErrorException(
      'Internal workspace provisioning token is not configured',
    );
  }

  const actualHeader = Array.isArray(internalToken)
    ? internalToken[0]
    : internalToken;
  const actualBearer = readBearerToken(authorization);
  const actualToken = actualHeader ?? actualBearer;

  if (actualToken !== expectedToken) {
    throw new UnauthorizedException('Invalid internal workspace token');
  }
}

function readBearerToken(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;

  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length);
}
