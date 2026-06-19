import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';

import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { UserService } from 'src/engine/core-modules/user/services/user.service';

type InternalWorkspaceProvisioningBody = {
  name?: string;
  slug?: string;
  primaryDomain?: string;
  serviceUserEmail?: string;
};

@Controller('internal/workspaces')
export class InternalWorkspaceProvisioningController {
  constructor(
    private readonly signInUpService: SignInUpService,
    private readonly userService: UserService,
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
    const workspaceUrl =
      body.primaryDomain ??
      (process.env.FRONT_BASE_URL
        ? `https://${subdomain}.${new URL(process.env.FRONT_BASE_URL).hostname}`
        : undefined);

    return {
      ok: true,
      id: result.workspace.id,
      workspaceId: result.workspace.id,
      workspaceUrl,
      workspaceName: result.workspace.displayName,
      workspaceSubdomain: result.workspace.subdomain,
    };
  }
}

function readBearerToken(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;

  if (!header?.startsWith('Bearer ')) {
    return null;
  }

  return header.slice('Bearer '.length);
}
