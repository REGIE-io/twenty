import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { ConnectedAccountProvider } from 'twenty-shared/types';
import { assertUnreachable, isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { AppOAuthRefreshAccessTokenService } from 'src/engine/core-modules/application/connection-provider/refresh/services/app-oauth-refresh-tokens.service';
import { type EncryptedString } from 'src/engine/core-modules/secret-encryption/branded-strings/encrypted-string.type';
import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import {
  ConnectedAccountRefreshAccessTokenException,
  ConnectedAccountRefreshAccessTokenExceptionCode,
} from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import { ConnectedAccountTokenEncryptionService } from 'src/engine/metadata-modules/connected-account/services/connected-account-token-encryption.service';
import { GoogleAPIRefreshAccessTokenService } from 'src/modules/connected-account/refresh-tokens-manager/drivers/google/services/google-api-refresh-tokens.service';
import { MicrosoftAPIRefreshAccessTokenService } from 'src/modules/connected-account/refresh-tokens-manager/drivers/microsoft/services/microsoft-api-refresh-tokens.service';
import { RegieTokenServiceClient } from 'src/modules/connected-account/token-delegation/services/regie-token-service.client';
import { getDelegatedMailboxId } from 'src/modules/connected-account/token-delegation/utils/get-delegated-mailbox-id.util';

// Tokens flowing through this service can be in two states depending on
// where they enter the pipeline. We model both shapes explicitly so the
// type system can prevent the #20819 class of bug (mixing encrypted and
// decrypted tokens in the same flow).
export type ConnectedAccountPlaintextTokens = {
  accessToken: PlaintextString;
  refreshToken: PlaintextString | null;
};

export type ConnectedAccountEncryptedTokens = {
  accessToken: EncryptedString;
  refreshToken: EncryptedString | null;
};

// Public return type of resolveTokens: always encrypted (either fresh from
// the database or freshly re-encrypted after a refresh round-trip).
export type ConnectedAccountTokens = ConnectedAccountEncryptedTokens;

const CONNECTED_ACCOUNT_ACCESS_TOKEN_EXPIRATION = 1000 * 60 * 60;

@Injectable()
export class ConnectedAccountRefreshTokensService {
  private readonly logger = new Logger(
    ConnectedAccountRefreshTokensService.name,
  );

  constructor(
    private readonly googleAPIRefreshAccessTokenService: GoogleAPIRefreshAccessTokenService,
    private readonly microsoftAPIRefreshAccessTokenService: MicrosoftAPIRefreshAccessTokenService,
    private readonly appOAuthRefreshAccessTokenService: AppOAuthRefreshAccessTokenService,
    private readonly connectedAccountTokenEncryptionService: ConnectedAccountTokenEncryptionService,
    private readonly regieTokenServiceClient: RegieTokenServiceClient,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
  ) {}

  async resolveTokens(
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
  ): Promise<ConnectedAccountTokens> {
    const isAccessTokenValid =
      await this.isAccessTokenStillValid(connectedAccount);

    if (isAccessTokenValid) {
      this.logger.debug(
        `Reusing valid access token for connected account ${connectedAccount.id.slice(0, 7)} in workspace ${workspaceId.slice(0, 7)}`,
      );

      return this.getExistingEncryptedTokens(connectedAccount, workspaceId);
    }

    // Must precede the refresh-token guard: a delegated account holds no refresh token
    // by design, so the guard below would reject it before we ever ask Regie.
    const delegatedMailboxId = getDelegatedMailboxId(connectedAccount);

    if (isDefined(delegatedMailboxId)) {
      return this.resolveDelegatedTokens(
        connectedAccount,
        delegatedMailboxId,
        workspaceId,
      );
    }

    const encryptedRefreshToken = connectedAccount.refreshToken;

    if (!isDefined(encryptedRefreshToken)) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `No refresh token found for connected account ${connectedAccount.id} in workspace ${workspaceId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND,
      );
    }

    this.logger.debug(
      `Access token expired for connected account ${connectedAccount.id} in workspace ${workspaceId}, refreshing...`,
    );

    return this.performRefreshAndSave(
      connectedAccount,
      encryptedRefreshToken,
      workspaceId,
    );
  }

  // Regie owns the grant for these accounts and stays the only party that ever spends
  // the refresh token. We borrow a short-lived access token instead, which is what makes
  // single-use Microsoft refresh tokens safe across two systems.
  private async resolveDelegatedTokens(
    connectedAccount: ConnectedAccountEntity,
    mailboxId: string,
    workspaceId: string,
  ): Promise<ConnectedAccountTokens> {
    this.logger.debug(
      `Delegating token resolution to Regie for connected account ${connectedAccount.id.slice(0, 7)} in workspace ${workspaceId.slice(0, 7)}`,
    );

    const delegated = await this.regieTokenServiceClient.fetchAccessToken({
      mailboxId,
      connectedAccountId: connectedAccount.id,
    });

    const encryptedAccessToken =
      this.connectedAccountTokenEncryptionService.encrypt({
        plaintext: delegated.accessToken,
        workspaceId,
      });

    await this.connectedAccountRepository.update(
      { id: connectedAccount.id, workspaceId },
      {
        accessToken: encryptedAccessToken,
        lastCredentialsRefreshedAt: this.toValidityAnchor(delegated.expiresAt),
      },
    );

    return { accessToken: encryptedAccessToken, refreshToken: null };
  }

  // isAccessTokenStillValid measures staleness as "refreshed within the assumed
  // lifetime". Back-dating the anchor to expiry-minus-lifetime expresses Regie's real
  // expiry in those terms, so the existing validity check needs no delegation branch.
  private toValidityAnchor(expiresAt: Date | null): Date {
    if (!isDefined(expiresAt)) {
      return new Date();
    }

    return new Date(
      expiresAt.getTime() - CONNECTED_ACCOUNT_ACCESS_TOKEN_EXPIRATION,
    );
  }

  private getExistingEncryptedTokens(
    connectedAccount: ConnectedAccountEntity,
    workspaceId: string,
  ): ConnectedAccountTokens {
    if (!isDefined(connectedAccount.accessToken)) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `Access token is required for connected account ${connectedAccount.id} in workspace ${workspaceId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.ACCESS_TOKEN_NOT_FOUND,
      );
    }

    return {
      accessToken: connectedAccount.accessToken,
      refreshToken: connectedAccount.refreshToken,
    };
  }

  private async performRefreshAndSave(
    connectedAccount: ConnectedAccountEntity,
    encryptedRefreshToken: EncryptedString,
    workspaceId: string,
  ): Promise<ConnectedAccountTokens> {
    const decryptedRefreshToken =
      this.connectedAccountTokenEncryptionService.decrypt({
        ciphertext: encryptedRefreshToken,
        workspaceId,
      });

    const plaintextTokens = await this.refreshTokens(
      connectedAccount,
      decryptedRefreshToken,
      workspaceId,
    );

    const {
      encryptedAccessToken,
      encryptedRefreshToken: reEncryptedRefreshToken,
    } = this.connectedAccountTokenEncryptionService.encryptTokenPair({
      accessToken: plaintextTokens.accessToken,
      refreshToken: plaintextTokens.refreshToken,
      workspaceId,
    });

    await this.connectedAccountRepository.update(
      { id: connectedAccount.id, workspaceId },
      {
        accessToken: encryptedAccessToken,
        refreshToken: reEncryptedRefreshToken,
        lastCredentialsRefreshedAt: new Date(),
      },
    );

    return {
      accessToken: encryptedAccessToken,
      refreshToken: reEncryptedRefreshToken,
    };
  }

  async isAccessTokenStillValid(
    connectedAccount: ConnectedAccountEntity,
  ): Promise<boolean> {
    switch (connectedAccount.provider) {
      case ConnectedAccountProvider.GOOGLE:
      case ConnectedAccountProvider.MICROSOFT:
      case ConnectedAccountProvider.APP: {
        // TODO: drive this from the connection provider definition
        if (
          connectedAccount.provider === ConnectedAccountProvider.APP &&
          !isDefined(connectedAccount.refreshToken)
        ) {
          return true;
        }

        if (!connectedAccount.lastCredentialsRefreshedAt) {
          return false;
        }

        const BUFFER_TIME = 5 * 60 * 1000;

        const tokenExpirationTime =
          CONNECTED_ACCOUNT_ACCESS_TOKEN_EXPIRATION - BUFFER_TIME;

        return (
          connectedAccount.lastCredentialsRefreshedAt >
          new Date(Date.now() - tokenExpirationTime)
        );
      }
      case ConnectedAccountProvider.IMAP_SMTP_CALDAV:
      case ConnectedAccountProvider.OIDC:
      case ConnectedAccountProvider.SAML:
      case ConnectedAccountProvider.EMAIL_GROUP:
        return true;
      default:
        return assertUnreachable(
          connectedAccount.provider,
          `Provider ${connectedAccount.provider} not supported`,
        );
    }
  }

  async refreshTokens(
    connectedAccount: ConnectedAccountEntity,
    refreshToken: PlaintextString,
    workspaceId: string,
  ): Promise<ConnectedAccountPlaintextTokens> {
    try {
      switch (connectedAccount.provider) {
        case ConnectedAccountProvider.GOOGLE:
          return await this.googleAPIRefreshAccessTokenService.refreshTokens(
            refreshToken,
          );
        case ConnectedAccountProvider.MICROSOFT:
          return await this.microsoftAPIRefreshAccessTokenService.refreshTokens(
            refreshToken,
          );
        case ConnectedAccountProvider.APP:
          return await this.appOAuthRefreshAccessTokenService.refreshTokens(
            connectedAccount,
            refreshToken,
          );
        case ConnectedAccountProvider.IMAP_SMTP_CALDAV:
        case ConnectedAccountProvider.OIDC:
        case ConnectedAccountProvider.SAML:
        case ConnectedAccountProvider.EMAIL_GROUP:
          throw new ConnectedAccountRefreshAccessTokenException(
            `Token refresh is not supported for ${connectedAccount.provider} provider for connected account ${connectedAccount.id} in workspace ${workspaceId}`,
            ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED,
          );
        default:
          return assertUnreachable(
            connectedAccount.provider,
            `Provider ${connectedAccount.provider} not supported`,
          );
      }
    } catch (error) {
      this.logger.log(
        `Error while refreshing tokens on connected account ${connectedAccount.id} in workspace ${workspaceId}`,
        error,
      );
      throw error;
    }
  }
}
