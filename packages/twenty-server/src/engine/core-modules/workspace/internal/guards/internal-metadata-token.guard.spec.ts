import {
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';

describe('InternalMetadataTokenGuard', () => {
  const guard = new InternalMetadataTokenGuard({
    get: jest.fn().mockReturnValue('internal-secret'),
  } as unknown as TwentyConfigService);
  const context = (authorization?: string, internalToken?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization, 'x-internal-token': internalToken },
        }),
      }),
    }) as unknown as ExecutionContext;

  it('rejects callers without the internal secret', () => {
    expect(guard.canActivate(context())).toBe(false);
    expect(guard.canActivate(context('Bearer external-token'))).toBe(false);
  });

  it('accepts the configured service-to-service bearer token', () => {
    expect(guard.canActivate(context('Bearer internal-secret'))).toBe(true);
  });

  it('accepts the configured service-to-service header token', () => {
    expect(guard.canActivate(context(undefined, 'internal-secret'))).toBe(true);
  });

  it('rejects an invalid header token', () => {
    expect(guard.canActivate(context(undefined, 'external-token'))).toBe(false);
  });

  it('does not let a valid header override an invalid bearer token', () => {
    expect(
      guard.canActivate(context('Bearer external-token', 'internal-secret')),
    ).toBe(false);
  });

  it('fails closed when the internal secret is not configured', () => {
    const unconfiguredGuard = new InternalMetadataTokenGuard({
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as TwentyConfigService);

    expect(() =>
      unconfiguredGuard.canActivate(context('Bearer internal-secret')),
    ).toThrow(InternalServerErrorException);
  });
});
