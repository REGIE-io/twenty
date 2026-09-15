import { CommandShutdownService } from 'src/database/commands/command-runners/command-shutdown.service';
import {
  UPGRADE_SEQUENCE_ADVISORY_LOCK_NAME,
  UpgradeCommand,
} from 'src/database/commands/upgrade-version-command/upgrade.command';
import {
  type PostgresAdvisoryLockResult,
  PostgresAdvisoryLockService,
} from 'src/database/typeorm/postgres-advisory-lock.service';
import { UpgradeSequenceReaderService } from 'src/engine/core-modules/upgrade/services/upgrade-sequence-reader.service';
import { UpgradeSequenceRunnerService } from 'src/engine/core-modules/upgrade/services/upgrade-sequence-runner.service';
import { UpgradeStatusService } from 'src/engine/core-modules/upgrade/services/upgrade-status.service';

describe('UpgradeCommand', () => {
  const upgradeSequenceReaderService = {
    getUpgradeSequence: jest.fn().mockReturnValue([]),
  } as unknown as UpgradeSequenceReaderService;
  const upgradeSequenceRunnerService = {
    run: jest.fn().mockResolvedValue({
      totalFailures: 0,
      totalSuccesses: 0,
    }),
  } as unknown as UpgradeSequenceRunnerService;
  const upgradeStatusService = {
    invalidateInstanceAndAllWorkspacesStatus: jest
      .fn()
      .mockResolvedValue(undefined),
  } as unknown as UpgradeStatusService;
  const commandShutdownService = {
    listenToShutdownSignals: jest.fn(),
  } as unknown as CommandShutdownService;
  const postgresAdvisoryLockService = {
    tryWithLock: jest.fn(),
  } as unknown as PostgresAdvisoryLockService;

  const makeCommand = () =>
    new UpgradeCommand(
      upgradeSequenceReaderService,
      upgradeSequenceRunnerService,
      upgradeStatusService,
      commandShutdownService,
      postgresAdvisoryLockService,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs the complete upgrade sequence while holding the database lock', async () => {
    jest.spyOn(postgresAdvisoryLockService, 'tryWithLock').mockImplementation(
      async <T>(
        _lockName: string,
        callback: () => Promise<T>,
      ): Promise<PostgresAdvisoryLockResult<T>> => ({
        acquired: true,
        value: await callback(),
      }),
    );

    await makeCommand().run([], {});

    expect(postgresAdvisoryLockService.tryWithLock).toHaveBeenCalledWith(
      UPGRADE_SEQUENCE_ADVISORY_LOCK_NAME,
      expect.any(Function),
    );
    expect(upgradeSequenceRunnerService.run).toHaveBeenCalledTimes(1);
    expect(
      upgradeStatusService.invalidateInstanceAndAllWorkspacesStatus,
    ).toHaveBeenCalledTimes(1);
  });

  it('fails before reading the sequence when another runner owns the lock', async () => {
    jest
      .spyOn(postgresAdvisoryLockService, 'tryWithLock')
      .mockResolvedValue({ acquired: false });

    await expect(makeCommand().run([], {})).rejects.toThrow(
      'Another upgrade sequence is already running against this database',
    );

    expect(
      upgradeSequenceReaderService.getUpgradeSequence,
    ).not.toHaveBeenCalled();
    expect(upgradeSequenceRunnerService.run).not.toHaveBeenCalled();
    expect(
      upgradeStatusService.invalidateInstanceAndAllWorkspacesStatus,
    ).toHaveBeenCalledTimes(1);
  });
});
