import { MODULE_METADATA } from '@nestjs/common/constants';

import { TypeORMModule } from 'src/database/typeorm/typeorm.module';
import { WorkspaceCleanerModule } from 'src/engine/workspace-manager/workspace-cleaner/workspace-cleaner.module';

describe('WorkspaceCleanerModule', () => {
  it('imports the provider for PostgreSQL advisory locking', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      WorkspaceCleanerModule,
    ) as unknown[];

    expect(imports).toContain(TypeORMModule);
  });
});
