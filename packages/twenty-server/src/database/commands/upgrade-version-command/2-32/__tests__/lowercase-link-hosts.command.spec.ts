import { isDefined } from 'twenty-shared/utils';
import { v4 as uuid } from 'uuid';

import { LowercaseLinkHostsCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1791967456263-lowercase-link-hosts.command';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

const BATCH_SIZE = 1000;
const SCHEMED_ORIGIN_PATTERN = String.raw`^(\s*[a-z][a-z0-9+.-]*://[^/?#@]*)(?=[/?#]|$)`;
const SCHEMELESS_HOST_PATTERN = String.raw`^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=(?::[0-9]+)?(?:[/?#]|$))`;

const workspaceId = uuid();
const schemaName = getWorkspaceSchemaName(workspaceId);

type LinkTable = 'company' | 'person';

const fakeIds = (first: number, last: number) =>
  Array.from(
    { length: last - first + 1 },
    (_, offset) =>
      `00000000-0000-0000-0000-${String(first + offset).padStart(12, '0')}`,
  );

const tableOfStatement = (sql: string): LinkTable => {
  if (sql.includes('"company"')) {
    return 'company';
  }

  if (sql.includes('"person"')) {
    return 'person';
  }

  throw new Error(`Unexpected table in query: ${sql}`);
};

const isUpdate = (sql: string) => sql.includes('UPDATE');

const isFind = (sql: string) =>
  !isUpdate(sql) && sql.includes('prefix <> lower(prefix)');

const buildCommand = ({
  existingTables,
  linksToLowercase,
  updateError,
}: {
  existingTables: LinkTable[];
  linksToLowercase: Record<LinkTable, number>;
  updateError?: Error;
}) => {
  const query = jest
    .fn<Promise<unknown>, [string, unknown[]?, boolean?]>()
    .mockImplementation(async (sql, parameters) => {
      if (sql.includes('information_schema')) {
        const requestedTable = parameters?.[1];

        return existingTables.some((table) => table === requestedTable)
          ? [{ '?column?': 1 }]
          : [];
      }

      if (isUpdate(sql)) {
        if (isDefined(updateError)) {
          throw updateError;
        }

        return { records: [] };
      }

      if (isFind(sql)) {
        return fakeIds(1, linksToLowercase[tableOfStatement(sql)]).map(
          (id) => ({ id }),
        );
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
  const command = new LowercaseLinkHostsCommand(
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
  const finds = () => query.mock.calls.filter(([sql]) => isFind(sql));
  const updatesOn = (table: LinkTable) =>
    callsContaining(`UPDATE "${schemaName}"."${table}"`);

  return { run, query, release, callsContaining, finds, updatesOn };
};

it('skips a link column the workspace does not have', async () => {
  const { run, query, release, callsContaining, updatesOn } = buildCommand({
    existingTables: ['company'],
    linksToLowercase: { company: 2, person: 0 },
  });

  await run(false);

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('information_schema'),
    [schemaName, 'person', 'linkedinLinkPrimaryLinkUrl'],
  );
  expect(updatesOn('company')).toHaveLength(1);
  expect(callsContaining('"person"')).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('counts without writing on a dry run', async () => {
  const { run, release, callsContaining, finds } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: { company: 7, person: 3 },
  });

  await run(true);

  expect(finds()).toEqual([
    [
      expect.stringContaining('"company"'),
      [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN],
    ],
    [
      expect.stringContaining('"person"'),
      [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN],
    ],
  ]);
  expect(callsContaining('UPDATE')).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('updates the rows it found in batches', async () => {
  const { run, release, updatesOn } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: { company: BATCH_SIZE + 3, person: 0 },
  });

  await run(false);

  expect(updatesOn('company')).toEqual([
    [
      expect.stringContaining('SET "domainNamePrimaryLinkUrl"'),
      [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN, fakeIds(1, BATCH_SIZE)],
      true,
    ],
    [
      expect.stringContaining('SET "domainNamePrimaryLinkUrl"'),
      [
        SCHEMED_ORIGIN_PATTERN,
        SCHEMELESS_HOST_PATTERN,
        fakeIds(BATCH_SIZE + 1, BATCH_SIZE + 3),
      ],
      true,
    ],
  ]);
  expect(updatesOn('person')).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases the query runner when a batch fails', async () => {
  const failure = new Error('statement timeout');
  const { run, release } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: { company: 1, person: 0 },
    updateError: failure,
  });

  await expect(run(false)).rejects.toBe(failure);

  expect(release).toHaveBeenCalledTimes(1);
});
