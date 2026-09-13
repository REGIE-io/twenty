import { type DataSource } from 'typeorm';

import { type DnsManagerService } from 'src/engine/core-modules/dns-manager/services/dns-manager.service';
import { type EmailingDomainService } from 'src/engine/core-modules/emailing-domain/services/emailing-domain.service';
import { type FileService } from 'src/engine/core-modules/file/services/file.service';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

describe('WorkspaceService external resource deletion', () => {
  const workspaceId = '20202020-0000-4000-8000-000000000001';

  const makeService = () => {
    const workspaceRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: workspaceId,
        customDomain: 'e2e.example.com',
      }),
    };
    const emailingDomainRepository = {
      find: jest
        .fn()
        .mockResolvedValue([
          { domain: 'mail-one.example.com' },
          { domain: 'mail-two.example.com' },
        ]),
    };
    const coreDataSource = {
      getRepository: jest.fn().mockReturnValue(emailingDomainRepository),
    };
    const fileService = { deleteWorkspaceFolder: jest.fn() };
    const emailingDomainService = {
      cleanupEmailingDomainsForWorkspace: jest.fn(),
    };
    const dnsManagerService = { deleteHostnameSilently: jest.fn() };
    const service = Object.create(
      WorkspaceService.prototype,
    ) as WorkspaceService;

    Reflect.set(service, 'workspaceRepository', workspaceRepository);
    Reflect.set(
      service,
      'coreDataSource',
      coreDataSource as unknown as DataSource,
    );
    Reflect.set(service, 'fileService', fileService as unknown as FileService);
    Reflect.set(
      service,
      'emailingDomainService',
      emailingDomainService as unknown as EmailingDomainService,
    );
    Reflect.set(
      service,
      'dnsManagerService',
      dnsManagerService as unknown as DnsManagerService,
    );
    Reflect.set(service, 'logger', { log: jest.fn() });

    return {
      dnsManagerService,
      emailingDomainService,
      fileService,
      service,
    };
  };

  it('does not finish the phase until files, emailing domains, and DNS are deleted', async () => {
    const { dnsManagerService, emailingDomainService, fileService, service } =
      makeService();
    let finishEmailingDomainCleanup: () => void = () => undefined;
    let signalEmailingDomainCleanupStarted: () => void = () => undefined;
    const emailingDomainCleanupStarted = new Promise<void>((resolve) => {
      signalEmailingDomainCleanupStarted = resolve;
    });

    emailingDomainService.cleanupEmailingDomainsForWorkspace.mockImplementation(
      () => {
        signalEmailingDomainCleanupStarted();

        return new Promise<void>((resolve) => {
          finishEmailingDomainCleanup = resolve;
        });
      },
    );

    const deletion = service.hardDeleteWorkspaceExternalResources(workspaceId);

    await emailingDomainCleanupStarted;
    expect(fileService.deleteWorkspaceFolder).toHaveBeenCalledWith(workspaceId);
    expect(
      emailingDomainService.cleanupEmailingDomainsForWorkspace,
    ).toHaveBeenCalledWith(workspaceId, [
      'mail-one.example.com',
      'mail-two.example.com',
    ]);
    expect(dnsManagerService.deleteHostnameSilently).not.toHaveBeenCalled();

    finishEmailingDomainCleanup();
    await deletion;

    expect(dnsManagerService.deleteHostnameSilently).toHaveBeenCalledWith(
      'e2e.example.com',
    );
  });

  it('propagates external cleanup failure without advancing to later work', async () => {
    const failure = new Error('emailing domain cleanup failed');
    const { dnsManagerService, emailingDomainService, service } = makeService();

    emailingDomainService.cleanupEmailingDomainsForWorkspace.mockRejectedValue(
      failure,
    );

    await expect(
      service.hardDeleteWorkspaceExternalResources(workspaceId),
    ).rejects.toBe(failure);
    expect(dnsManagerService.deleteHostnameSilently).not.toHaveBeenCalled();
  });
});
