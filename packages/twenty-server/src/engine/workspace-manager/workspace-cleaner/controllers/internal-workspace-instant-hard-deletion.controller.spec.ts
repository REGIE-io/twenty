import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { InternalMetadataTokenGuard } from 'src/engine/core-modules/workspace/internal/guards/internal-metadata-token.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { InternalWorkspaceInstantHardDeletionController } from 'src/engine/workspace-manager/workspace-cleaner/controllers/internal-workspace-instant-hard-deletion.controller';
import { type InternalWorkspaceInstantHardDeletionService } from 'src/engine/workspace-manager/workspace-cleaner/services/internal-workspace-instant-hard-deletion.service';

describe('InternalWorkspaceInstantHardDeletionController', () => {
  it('is protected by the service-to-service token guard', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        InternalWorkspaceInstantHardDeletionController,
      ),
    ).toEqual([InternalMetadataTokenGuard, NoPermissionGuard]);
  });

  it('exposes an explicitly named instant hard deletion operation', async () => {
    const service = {
      request: jest.fn().mockResolvedValue({ completed: false }),
    };
    const controller = new InternalWorkspaceInstantHardDeletionController(
      service as unknown as InternalWorkspaceInstantHardDeletionService,
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        InternalWorkspaceInstantHardDeletionController.prototype
          .requestInstantHardDeletion,
      ),
    ).toBe(':workspaceId/instant-hard-deletion');
    const input = {
      organizationId: 'org_e2e_run_1',
      workspaceSlug: 'org-e2e-run-1',
    };

    await expect(
      controller.requestInstantHardDeletion(
        '20202020-0000-4000-8000-000000000001',
        input,
      ),
    ).resolves.toEqual({ completed: false });
    expect(service.request).toHaveBeenCalledWith(
      '20202020-0000-4000-8000-000000000001',
      input,
    );
  });
});
