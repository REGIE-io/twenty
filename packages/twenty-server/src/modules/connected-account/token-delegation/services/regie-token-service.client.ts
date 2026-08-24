import { Injectable, Logger } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import {
  type PlaintextString,
  plaintextStringSchema,
} from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import {
  ConnectedAccountRefreshAccessTokenException,
  ConnectedAccountRefreshAccessTokenExceptionCode,
} from 'src/engine/metadata-modules/connected-account/exceptions/connected-account-refresh-tokens.exception';

const REQUEST_TIMEOUT_MS = 10_000;

export type DelegatedAccessToken = {
  accessToken: PlaintextString;
  // Absolute expiry when the provider exposes one. Google's access token is opaque, so
  // this is null there and the caller falls back to Twenty's assumed lifetime.
  expiresAt: Date | null;
};

@Injectable()
export class RegieTokenServiceClient {
  private readonly logger = new Logger(RegieTokenServiceClient.name);

  constructor(private readonly twentyConfigService: TwentyConfigService) {}

  async fetchAccessToken({
    mailboxId,
    connectedAccountId,
  }: {
    mailboxId: string;
    connectedAccountId: string;
  }): Promise<DelegatedAccessToken> {
    const baseUrl = this.twentyConfigService.get('REGIE_TOKEN_SERVICE_URL');
    const secret = this.twentyConfigService.get('REGIE_TOKEN_SERVICE_SECRET');

    if (!isDefined(baseUrl) || !isDefined(secret)) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `Token delegation is not configured, cannot resolve tokens for connected account ${connectedAccountId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.REFRESH_TOKEN_NOT_FOUND,
      );
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/internal/mailbox/${encodeURIComponent(mailboxId)}/access-token`;

    // Plain fetch rather than SecureHttpClientService on purpose. That client runs an
    // SSRF-safe agent that rejects private addresses, which is exactly where this
    // operator-configured internal endpoint lives — locally and in production.
    const response = await this.post({ url, secret, connectedAccountId });

    return this.readResponse(response, connectedAccountId);
  }

  private async post({
    url,
    secret,
    connectedAccountId,
  }: {
    url: string;
    secret: string;
    connectedAccountId: string;
  }): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          // Regie's InternalOnlyGuard keys on x-api-key; a Bearer token is rejected.
          'x-api-key': secret,
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Timeouts and DNS/connection failures mean Regie is briefly unreachable. Marking
      // these terminal would park every channel in the instance on a single deploy.
      this.logger.warn(
        `Could not reach the Regie token service for connected account ${connectedAccountId}`,
        error,
      );

      throw new ConnectedAccountRefreshAccessTokenException(
        `Could not reach the Regie token service for connected account ${connectedAccountId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR,
      );
    }

    if (!response.ok) {
      throw this.toException(response.status, connectedAccountId);
    }

    return response.json();
  }

  // 401/403/404 mean the grant is gone or the mailbox no longer exists, so the channel
  // needs a human. Everything else stays retryable.
  private toException(
    status: number,
    connectedAccountId: string,
  ): ConnectedAccountRefreshAccessTokenException {
    const isTerminal = status === 401 || status === 403 || status === 404;

    this.logger.warn(
      `Regie returned ${status} for connected account ${connectedAccountId}`,
    );

    return new ConnectedAccountRefreshAccessTokenException(
      isTerminal
        ? `Regie reports no usable grant for connected account ${connectedAccountId} (status ${status})`
        : `Regie token service failed for connected account ${connectedAccountId} (status ${status})`,
      isTerminal
        ? ConnectedAccountRefreshAccessTokenExceptionCode.INVALID_REFRESH_TOKEN
        : ConnectedAccountRefreshAccessTokenExceptionCode.TEMPORARY_NETWORK_ERROR,
    );
  }

  private readResponse(
    body: unknown,
    connectedAccountId: string,
  ): DelegatedAccessToken {
    // Regie wraps successful responses in a { status, data } envelope. Tolerating both
    // shapes keeps this working if the endpoint is ever called without the interceptor.
    const payload = (body ?? {}) as { data?: unknown };
    const { accessToken, expiresAt } = (payload.data ?? payload) as {
      accessToken?: unknown;
      expiresAt?: unknown;
    };

    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new ConnectedAccountRefreshAccessTokenException(
        `Regie token service returned no access token for connected account ${connectedAccountId}`,
        ConnectedAccountRefreshAccessTokenExceptionCode.ACCESS_TOKEN_NOT_FOUND,
      );
    }

    const parsedExpiresAt =
      typeof expiresAt === 'string' ? new Date(expiresAt) : null;

    return {
      accessToken: plaintextStringSchema.parse(accessToken),
      expiresAt:
        isDefined(parsedExpiresAt) && !Number.isNaN(parsedExpiresAt.getTime())
          ? parsedExpiresAt
          : null,
    };
  }
}
