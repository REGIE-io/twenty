import { type ExecutionContext } from '@nestjs/common';

import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';

describe('InternalMetadataTokenGuard', () => {
  const guard = new InternalMetadataTokenGuard({
    get: jest.fn().mockReturnValue('internal-secret'),
  } as unknown as TwentyConfigService);
  const context = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization } }),
      }),
    }) as unknown as ExecutionContext;

  it('rejects callers without the internal secret', () => {
    expect(guard.canActivate(context())).toBe(false);
    expect(guard.canActivate(context('Bearer external-token'))).toBe(false);
  });

  it('accepts the configured service-to-service bearer token', () => {
    expect(guard.canActivate(context('Bearer internal-secret'))).toBe(true);
  });
});
