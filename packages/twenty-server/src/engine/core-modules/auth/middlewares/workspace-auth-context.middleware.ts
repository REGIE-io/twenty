import { Injectable, type NestMiddleware } from '@nestjs/common';

import { type NextFunction, type Request, type Response } from 'express';
import { parseRegieSource } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';

import {
  AuthException,
  AuthExceptionCode,
} from 'src/engine/core-modules/auth/auth.exception';
import { withWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { buildApiKeyAuthContext } from 'src/engine/core-modules/auth/utils/build-api-key-auth-context.util';
import { buildApplicationAuthContext } from 'src/engine/core-modules/auth/utils/build-application-auth-context.util';
import { buildPendingActivationUserAuthContext } from 'src/engine/core-modules/auth/utils/build-pending-activation-user-auth-context.util';
import { buildUserAuthContext } from 'src/engine/core-modules/auth/utils/build-user-auth-context.util';
import { applyWorkspaceSentryContext } from 'src/engine/core-modules/sentry/utils/apply-workspace-sentry-context.util';

@Injectable()
export class WorkspaceAuthContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (!isDefined(req.workspace)) {
      next();

      return;
    }

    const authContext = this.buildAuthContext(req);

    applyWorkspaceSentryContext(authContext);

    void withWorkspaceAuthContext(authContext, () => {
      next();
    });
  }

  private buildAuthContext(req: Request): WorkspaceAuthContext {
    // Regie threads the write's source, and for user-driven writes the acting member,
    // as headers. Only an API-key caller (Regie's backend) is trusted to name a member
    // on another member's behalf; a browser session can never spoof one this way.
    const regieSource = parseRegieSource(req.headers['x-regie-source']);

    if (isDefined(req.apiKey)) {
      const regieMemberIdHeader = req.headers['x-regie-member-id'];
      const regieMemberId =
        typeof regieMemberIdHeader === 'string'
          ? regieMemberIdHeader
          : undefined;

      return buildApiKeyAuthContext({
        workspace: req.workspace!,
        apiKey: req.apiKey,
        regieSource,
        workspaceMemberId: regieMemberId,
      });
    }

    if (
      isDefined(req.userWorkspaceId) &&
      isDefined(req.workspaceMemberId) &&
      isDefined(req.workspaceMember) &&
      isDefined(req.user)
    ) {
      return buildUserAuthContext({
        workspace: req.workspace!,
        userWorkspaceId: req.userWorkspaceId,
        user: req.user,
        workspaceMemberId: req.workspaceMemberId,
        workspaceMember: req.workspaceMember,
        application: req.application,
        regieSource,
      });
    }

    if (isDefined(req.application)) {
      return buildApplicationAuthContext({
        workspace: req.workspace!,
        application: req.application,
      });
    }

    if (isDefined(req.userWorkspaceId) && isDefined(req.user)) {
      return buildPendingActivationUserAuthContext({
        workspace: req.workspace!,
        userWorkspaceId: req.userWorkspaceId,
        user: req.user,
      });
    }

    throw new AuthException(
      'No authentication context found',
      AuthExceptionCode.UNAUTHENTICATED,
    );
  }
}
