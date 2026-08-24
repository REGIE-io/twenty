import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { google, type Auth } from 'googleapis';
import { ConnectedAccountProvider } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { Repository } from 'typeorm';

import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { ConnectedAccountEntity } from 'src/engine/metadata-modules/connected-account/entities/connected-account.entity';
import {
  ConnectedAccountRefreshAccessTokenException,
  ConnectedAccountRefreshAccessTokenExceptionCode,
} from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';
import { ConnectedAccountTokenEncryptionService } from 'src/engine/metadata-modules/connected-account/services/connected-account-token-encryption.service';
import { ConnectedAccountRefreshTokensService } from 'src/modules/connected-account/refresh-tokens-manager/services/connected-account-refresh-tokens.service';

@Injectable()
export class GoogleOAuth2ClientProvider {
  constructor(
    private readonly twentyConfigService: TwentyConfigService,
    private readonly logger: Logger,
    private readonly connectedAccountRefreshTokensService: ConnectedAccountRefreshTokensService,
    private readonly connectedAccountTokenEncryptionService: ConnectedAccountTokenEncryptionService,
    @InjectRepository(ConnectedAccountEntity)
    private readonly connectedAccountRepository: Repository<ConnectedAccountEntity>,
  ) {}

  public async getClient(
    connectedAccountId: string,
  ): Promise<Auth.OAuth2Client> {
    const connectedAccount = await this.connectedAccountRepository.findOne({
      where: { id: connectedAccountId },
    });

    if (!isDefined(connectedAccount)) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `Connected account ${connectedAccountId} not found`,
        ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND,
      );
    }

    if (connectedAccount.provider !== ConnectedAccountProvider.GOOGLE) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `Connected account ${connectedAccountId} is not a Google provider (got ${connectedAccount.provider})`,
        ConnectedAccountRefreshAccessTokenExceptionCode.PROVIDER_NOT_SUPPORTED,
      );
    }

    const {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
    } = await this.connectedAccountRefreshTokensService.resolveTokens(
      connectedAccount,
      connectedAccount.workspaceId,
    );

    // A delegated account holds no refresh token: Regie owns the grant and vends a
    // short-lived access token per cycle. Crediting the client with that token instead
    // also stops googleapis refreshing on its own, which is the point of delegating.
    const encryptedCredential = encryptedRefreshToken ?? encryptedAccessToken;

    if (!isDefined(encryptedCredential)) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `No usable credential for connected account ${connectedAccountId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND,
      );
    }

    const plaintextCredential =
      this.connectedAccountTokenEncryptionService.decrypt({
        ciphertext: encryptedCredential,
        workspaceId: connectedAccount.workspaceId,
      });

    const credentials = isDefined(encryptedRefreshToken)
      ? { refresh_token: plaintextCredential }
      : { access_token: plaintextCredential };

    const clientId = this.twentyConfigService.get('AUTH_GOOGLE_CLIENT_ID');
    const clientSecret = this.twentyConfigService.get(
      'AUTH_GOOGLE_CLIENT_SECRET',
    );

    try {
      const oAuth2Client = new google.auth.OAuth2({
        clientId,
        clientSecret,
        transporterOptions: { fetchImplementation: fetch },
      });

      oAuth2Client.setCredentials(credentials);

      return oAuth2Client;
    } catch (error) {
      this.logger.error(`Error in ${GoogleOAuth2ClientProvider.name}`, error);

      throw error;
    }
  }
}
