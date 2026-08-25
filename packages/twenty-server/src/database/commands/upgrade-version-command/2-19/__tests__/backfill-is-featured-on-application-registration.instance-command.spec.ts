import { type DataSource } from 'typeorm';

import { BackfillIsFeaturedOnApplicationRegistrationSlowInstanceCommand } from 'src/database/commands/upgrade-version-command/2-19/2-19-instance-command-slow-1783120000000-backfill-is-featured-on-application-registration';

describe('BackfillIsFeaturedOnApplicationRegistrationSlowInstanceCommand', () => {
  let command: BackfillIsFeaturedOnApplicationRegistrationSlowInstanceCommand;

  beforeEach(() => {
    command =
      new BackfillIsFeaturedOnApplicationRegistrationSlowInstanceCommand();
  });

  const createQueryMock = ({
    hasIsFeatured,
  }: {
    hasIsFeatured: boolean;
  }) =>
    jest.fn(async (statement: string) => {
      if (statement.includes('pg_attribute')) {
        return [{ exists: hasIsFeatured }];
      }

      return undefined;
    });

  describe('runDataMigration', () => {
    it('flags the featured registrations', async () => {
      const query = createQueryMock({ hasIsFeatured: true });
      const dataSource = { query } as unknown as DataSource;

      await command.runDataMigration(dataSource);

      const statements = query.mock.calls.map((call) => call[0] as string);

      expect(statements).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'UPDATE "core"."applicationRegistration"\n       SET "isFeatured" = true',
          ),
        ]),
      );
    });

    // Regression: 2.20 renames isFeatured to isVetted, so a retry of this step
    // used to fail forever against the renamed column and wedge the sequence.
    it('no-ops when isFeatured has already been renamed', async () => {
      const query = createQueryMock({ hasIsFeatured: false });
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
