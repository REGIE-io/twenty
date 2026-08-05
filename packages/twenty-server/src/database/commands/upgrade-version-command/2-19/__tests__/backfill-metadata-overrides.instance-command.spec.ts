import { type DataSource } from 'typeorm';

import { BackfillMetadataOverridesSlowInstanceCommand } from 'src/database/commands/upgrade-version-command/2-19/2-19-instance-command-slow-1782986476000-backfill-metadata-overrides';

describe('BackfillMetadataOverridesSlowInstanceCommand', () => {
  let command: BackfillMetadataOverridesSlowInstanceCommand;

  beforeEach(() => {
    command = new BackfillMetadataOverridesSlowInstanceCommand();
  });

  // Routes each statement by shape so a new guard query cannot silently shift
  // positional mocks and turn a real assertion into a vacuous one.
  const createQueryMock = ({
    hasStandardOverrides,
    activeCounts = [3, 3, 3, 3],
  }: {
    hasStandardOverrides: boolean;
    activeCounts?: number[];
  }) => {
    const remainingCounts = [...activeCounts];

    return jest.fn(async (statement: string) => {
      if (statement.includes('pg_attribute')) {
        return [{ exists: hasStandardOverrides }];
      }

      if (statement.includes('count(*)')) {
        return [{ count: remainingCounts.shift() }];
      }

      return undefined;
    });
  };

  describe('runDataMigration', () => {
    it('copies standardOverrides into overrides for both tables', async () => {
      const query = createQueryMock({ hasStandardOverrides: true });
      const dataSource = { query } as unknown as DataSource;

      await command.runDataMigration(dataSource);

      const statements = query.mock.calls.map((call) => call[0] as string);

      for (const table of ['objectMetadata', 'fieldMetadata']) {
        expect(statements).toEqual(
          expect.arrayContaining([
            expect.stringContaining(
              `UPDATE "core"."${table}" SET "overrides" = "standardOverrides"`,
            ),
          ]),
        );
      }
    });

    it('aborts when the isActive row count changes', async () => {
      const query = createQueryMock({
        hasStandardOverrides: true,
        activeCounts: [5, 4],
      });
      const dataSource = { query } as unknown as DataSource;

      await expect(command.runDataMigration(dataSource)).rejects.toThrow(
        /"isActive" changed on "core"\."objectMetadata"/,
      );
    });

    // Regression: 2.20 drops standardOverrides, so a retry of this step used to
    // fail forever against the dropped column and wedge the upgrade sequence.
    it('no-ops when standardOverrides has already been dropped', async () => {
      const query = createQueryMock({ hasStandardOverrides: false });
      const dataSource = { query } as unknown as DataSource;

      await expect(
        command.runDataMigration(dataSource),
      ).resolves.toBeUndefined();

      const statements = query.mock.calls.map((call) => call[0] as string);

      expect(
        statements.filter((statement) => statement.includes('UPDATE')),
      ).toEqual([]);
    });
  });
});
