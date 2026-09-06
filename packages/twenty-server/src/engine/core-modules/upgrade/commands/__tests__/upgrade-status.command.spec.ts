import { UpgradeHealthEnum } from 'twenty-shared/types';

import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { UpgradeStatusCommand } from 'src/engine/core-modules/upgrade/commands/upgrade-status.command';
import { UpgradeStatusService } from 'src/engine/core-modules/upgrade/services/upgrade-status.service';

describe('UpgradeStatusCommand', () => {
  const upgradeStatusService = {
    getInstanceStatus: jest.fn(),
    getWorkspaceStatuses: jest.fn(),
  } as unknown as UpgradeStatusService;
  const twentyConfigService = {
    get: jest.fn().mockReturnValue('2.32.0'),
  } as unknown as TwentyConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('exits successfully when the instance and every workspace are current', async () => {
    jest.spyOn(upgradeStatusService, 'getInstanceStatus').mockResolvedValue({
      health: UpgradeHealthEnum.UP_TO_DATE,
      inferredVersion: '2.32.0',
      latestCommand: null,
    });
    jest.spyOn(upgradeStatusService, 'getWorkspaceStatuses').mockResolvedValue([
      {
        displayName: 'Current workspace',
        health: UpgradeHealthEnum.UP_TO_DATE,
        inferredVersion: '2.32.0',
        latestCommand: null,
        workspaceId: 'workspace-current',
      },
    ]);

    await expect(
      new UpgradeStatusCommand(upgradeStatusService, twentyConfigService).run(
        [],
        { failOnUnhealthy: true },
      ),
    ).resolves.toBeUndefined();
  });

  it('exits non-zero when a workspace is behind', async () => {
    jest.spyOn(upgradeStatusService, 'getInstanceStatus').mockResolvedValue({
      health: UpgradeHealthEnum.UP_TO_DATE,
      inferredVersion: '2.32.0',
      latestCommand: null,
    });
    jest.spyOn(upgradeStatusService, 'getWorkspaceStatuses').mockResolvedValue([
      {
        displayName: 'Behind workspace',
        health: UpgradeHealthEnum.BEHIND,
        inferredVersion: '2.31.0',
        latestCommand: null,
        workspaceId: 'workspace-behind',
      },
    ]);

    await expect(
      new UpgradeStatusCommand(upgradeStatusService, twentyConfigService).run(
        [],
        { failOnUnhealthy: true },
      ),
    ).rejects.toThrow(
      'Upgrade is not healthy: instance=UP_TO_DATE, workspaces=1 behind, 0 failed',
    );
  });

  it('preserves report-only behavior unless the deployment gate is requested', async () => {
    jest.spyOn(upgradeStatusService, 'getInstanceStatus').mockResolvedValue({
      health: UpgradeHealthEnum.FAILED,
      inferredVersion: '2.31.0',
      latestCommand: null,
    });
    jest
      .spyOn(upgradeStatusService, 'getWorkspaceStatuses')
      .mockResolvedValue([]);

    await expect(
      new UpgradeStatusCommand(upgradeStatusService, twentyConfigService).run(
        [],
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
