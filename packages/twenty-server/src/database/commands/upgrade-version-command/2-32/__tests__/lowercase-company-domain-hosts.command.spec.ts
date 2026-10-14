import { isDefined } from 'twenty-shared/utils';
import { v4 as uuid } from 'uuid';

import { LowercaseCompanyDomainHostsCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1791936000000-lowercase-company-domain-hosts.command';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

const BATCH_SIZE = 1000;
const SCHEMED_ORIGIN_PATTERN = String.raw`^(\s*[a-z][a-z0-9+.-]*://[^/?#@]*)(?=[/?#]|$)`;
const SCHEMELESS_HOST_PATTERN = String.raw`^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=(?::[0-9]+)?(?:[/?#]|$))`;

const workspaceId = uuid();
const schemaName = getWorkspaceSchemaName(workspaceId);

type UpdateOutcome = { affected: number } | Error;

const buildCommand = ({
  hasDomainColumn,
  domainsToLowercase,
  updateOutcomes,
}: {
  hasDomainColumn: boolean;
  domainsToLowercase: number;
  updateOutcomes: UpdateOutcome[];
}) => {
  const pendingUpdateOutcomes = [...updateOutcomes];
  const query = jest
    .fn<Promise<unknown>, [string, unknown[]?, boolean?]>()
    .mockImplementation(async (sql) => {
      if (sql.includes('information_schema')) {
        return hasDomainColumn ? [{ '?column?': 1 }] : [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: domainsToLowercase }];
      }

      if (sql.includes('UPDATE')) {
        const outcome = pendingUpdateOutcomes.shift();

        if (!isDefined(outcome)) {
          throw new Error('Unexpected extra UPDATE');
        }

        if (outcome instanceof Error) {
          throw outcome;
        }

        return outcome;
      }

      throw new Error(`Unexpected query: ${sql}`);
    });
  const release = jest.fn().mockResolvedValue(undefined);
  const dataSource = {
    createQueryRunner: () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      query,
      release,
    }),
  };
  const command = new LowercaseCompanyDomainHostsCommand(
    {} as never,
    dataSource as never,
  );
  const run = (dryRun: boolean) =>
    command.runOnWorkspace({
      workspaceId,
      index: 0,
      total: 1,
      options: { dryRun },
    });
  const callsContaining = (fragment: string) =>
    query.mock.calls.filter(([sql]) => sql.includes(fragment));

  return { run, query, release, callsContaining };
};

it('skips a workspace without a company domain column', async () => {
  const { run, query, release, callsContaining } = buildCommand({
    hasDomainColumn: false,
    domainsToLowercase: 0,
    updateOutcomes: [],
  });

  await run(false);

  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('information_schema'),
    [schemaName],
  );
  expect(callsContaining('UPDATE')).toHaveLength(0);
  expect(callsContaining('count(*)')).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('counts without writing on a dry run', async () => {
  const { run, query, release, callsContaining } = buildCommand({
    hasDomainColumn: true,
    domainsToLowercase: 7,
    updateOutcomes: [],
  });

  await run(true);

  expect(callsContaining('count(*)')).toEqual([
    [expect.any(String), [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN]],
  ]);
  expect(callsContaining('UPDATE')).toHaveLength(0);
  expect(query).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(1);
});

it('lowercases in batches until a batch comes back short', async () => {
  const { run, release, callsContaining } = buildCommand({
    hasDomainColumn: true,
    domainsToLowercase: 0,
    updateOutcomes: [
      { affected: BATCH_SIZE },
      { affected: BATCH_SIZE },
      { affected: 3 },
    ],
  });

  await run(false);

  const updates = callsContaining('UPDATE');

  expect(updates).toHaveLength(3);
  for (const [sql, parameters, useStructuredResult] of updates) {
    expect(sql).toContain(`UPDATE "${schemaName}"."company"`);
    expect(parameters).toEqual([
      SCHEMED_ORIGIN_PATTERN,
      SCHEMELESS_HOST_PATTERN,
      BATCH_SIZE,
    ]);
    expect(useStructuredResult).toBe(true);
  }
  expect(release).toHaveBeenCalledTimes(1);
});

it('stops after one batch when nothing needs lowercasing', async () => {
  const { run, release, callsContaining } = buildCommand({
    hasDomainColumn: true,
    domainsToLowercase: 0,
    updateOutcomes: [{ affected: 0 }],
  });

  await run(false);

  expect(callsContaining('UPDATE')).toHaveLength(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases the query runner when a batch fails', async () => {
  const failure = new Error('statement timeout');
  const { run, release } = buildCommand({
    hasDomainColumn: true,
    domainsToLowercase: 0,
    updateOutcomes: [failure],
  });

  await expect(run(false)).rejects.toBe(failure);

  expect(release).toHaveBeenCalledTimes(1);
});
