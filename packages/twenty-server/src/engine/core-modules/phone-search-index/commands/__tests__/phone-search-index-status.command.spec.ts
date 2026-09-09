import { PhoneSearchIndexStatusCommand } from 'src/engine/core-modules/phone-search-index/commands/phone-search-index-status.command';

describe('PhoneSearchIndexStatusCommand', () => {
  const availability = [
    { fieldStateAvailable: true, operationAvailable: true },
  ];
  const healthy = [
    {
      expectedFieldCount: '3',
      missingFieldStateCount: '0',
      unhealthyFieldStateCount: '0',
      activeOperationCount: '0',
      failedOperationCount: '0',
    },
  ];
  const emptyQueue = { getInFlightJobs: jest.fn().mockResolvedValue([]) };

  it('accepts fully converged phone-search state', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce(healthy);
    const command = new PhoneSearchIndexStatusCommand(
      { query } as never,
      emptyQueue as never,
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await expect(
      command.run([], { failOnUnhealthy: true }),
    ).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({
        expectedFieldCount: 3,
        missingFieldStateCount: 0,
        unhealthyFieldStateCount: 0,
        activeOperationCount: 0,
        failedOperationCount: 0,
        queueDepth: 0,
      }),
    );

    consoleSpy.mockRestore();
  });

  it('fails when an expected active phone field has no ready state', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce([
        {
          ...healthy[0],
          missingFieldStateCount: '1',
        },
      ]);
    const command = new PhoneSearchIndexStatusCommand(
      { query } as never,
      emptyQueue as never,
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await expect(command.run([], { failOnUnhealthy: true })).rejects.toThrow(
      'missingFieldStates=1',
    );

    consoleSpy.mockRestore();
  });

  it('waits until active operations complete', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce([
        {
          ...healthy[0],
          activeOperationCount: '2',
        },
      ])
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce(healthy);
    const command = new PhoneSearchIndexStatusCommand(
      { query } as never,
      emptyQueue as never,
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await expect(
      command.run([], {
        failOnUnhealthy: true,
        wait: true,
        timeoutSeconds: 1,
        pollIntervalSeconds: 0,
      }),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(4);

    consoleSpy.mockRestore();
  });

  it('waits until the phone-search queue is empty', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce(availability)
      .mockResolvedValueOnce(healthy);
    const queue = {
      getInFlightJobs: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'queued-job', data: {} }])
        .mockResolvedValueOnce([]),
    };
    const command = new PhoneSearchIndexStatusCommand(
      { query } as never,
      queue as never,
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await expect(
      command.run([], {
        failOnUnhealthy: true,
        wait: true,
        timeoutSeconds: 1,
        pollIntervalSeconds: 0,
      }),
    ).resolves.toBeUndefined();
    expect(queue.getInFlightJobs).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });

  it('fails before querying counts when the instance schema is missing', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { fieldStateAvailable: false, operationAvailable: false },
      ]);
    const command = new PhoneSearchIndexStatusCommand(
      { query } as never,
      emptyQueue as never,
    );

    await expect(command.run([], { failOnUnhealthy: true })).rejects.toThrow(
      'instance upgrade has not completed',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
