import { isDefined } from 'twenty-shared/utils';
import { v4 as uuid } from 'uuid';

import { LowercaseLinkHostsCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1791967456263-lowercase-link-hosts.command';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

const BATCH_SIZE = 1000;
const FIRST_ID = '00000000-0000-0000-0000-000000000000';
const SCHEMED_ORIGIN_PATTERN = String.raw`^(\s*[a-z][a-z0-9+.-]*://[^/?#@]*)(?=[/?#]|$)`;
const SCHEMELESS_HOST_PATTERN = String.raw`^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=(?::[0-9]+)?(?:[/?#]|$))`;

const workspaceId = uuid();
const schemaName = getWorkspaceSchemaName(workspaceId);

type LinkTable = 'company' | 'person';
type UpdateOutcome = { records: Array<{ id: string }> } | Error;

const fakeId = (index: number) =>
  `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;

const fakeRecords = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, offset) => ({
    id: fakeId(first + offset),
  }));

const tableOfStatement = (sql: string): LinkTable => {
  if (sql.includes('"company"')) {
    return 'company';
  }

  if (sql.includes('"person"')) {
    return 'person';
  }

  throw new Error(`Unexpected table in query: ${sql}`);
};

const buildCommand = ({
  existingTables,
  linksToLowercase,
  updateOutcomes,
}: {
  existingTables: LinkTable[];
  linksToLowercase: number;
  updateOutcomes: Record<LinkTable, UpdateOutcome[]>;
}) => {
  const pendingUpdateOutcomes: Record<LinkTable, UpdateOutcome[]> = {
    company: [...updateOutcomes.company],
    person: [...updateOutcomes.person],
  };
  const query = jest
    .fn<Promise<unknown>, [string, unknown[]?, boolean?]>()
    .mockImplementation(async (sql, parameters) => {
      if (sql.includes('information_schema')) {
        const requestedTable = parameters?.[1];

        return existingTables.some((table) => table === requestedTable)
          ? [{ '?column?': 1 }]
          : [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: linksToLowercase }];
      }

      if (sql.includes('UPDATE')) {
        const outcome = pendingUpdateOutcomes[tableOfStatement(sql)].shift();

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
  const updatesOn = (table: LinkTable) =>
    callsContaining(`UPDATE "${schemaName}"."${table}"`);

  return { run, query, release, callsContaining, updatesOn };
};

it('skips a link column the workspace does not have', async () => {
  const { run, query, release, callsContaining, updatesOn } = buildCommand({
    existingTables: ['company'],
    linksToLowercase: 0,
    updateOutcomes: { company: [{ records: [] }], person: [] },
  });

  await run(false);

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('information_schema'),
    [schemaName, 'person', 'linkedinLinkPrimaryLinkUrl'],
  );
  expect(updatesOn('company')).toHaveLength(1);
  expect(updatesOn('person')).toHaveLength(0);
  expect(callsContaining('count(*)')).toHaveLength(0);
  expect(callsContaining('"person"')).toHaveLength(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it('counts without writing on a dry run', async () => {
  const { run, release, callsContaining } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: 7,
    updateOutcomes: { company: [], person: [] },
  });

  await run(true);

  expect(callsContaining('count(*)')).toEqual([
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

it('resumes after the last updated id until a batch comes back short', async () => {
  const { run, release, updatesOn } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: 0,
    updateOutcomes: {
      company: [
        { records: fakeRecords(1, BATCH_SIZE) },
        { records: fakeRecords(BATCH_SIZE + 1, BATCH_SIZE + 3) },
      ],
      person: [{ records: [] }],
    },
  });

  await run(false);

  expect(updatesOn('company')).toEqual([
    [
      expect.stringContaining('SET "domainNamePrimaryLinkUrl"'),
      [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN, FIRST_ID, BATCH_SIZE],
      true,
    ],
    [
      expect.stringContaining('SET "domainNamePrimaryLinkUrl"'),
      [
        SCHEMED_ORIGIN_PATTERN,
        SCHEMELESS_HOST_PATTERN,
        fakeId(BATCH_SIZE),
        BATCH_SIZE,
      ],
      true,
    ],
  ]);
  expect(updatesOn('person')).toEqual([
    [
      expect.stringContaining('SET "linkedinLinkPrimaryLinkUrl"'),
      [SCHEMED_ORIGIN_PATTERN, SCHEMELESS_HOST_PATTERN, FIRST_ID, BATCH_SIZE],
      true,
    ],
  ]);
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases the query runner when a batch fails', async () => {
  const failure = new Error('statement timeout');
  const { run, release } = buildCommand({
    existingTables: ['company', 'person'],
    linksToLowercase: 0,
    updateOutcomes: { company: [failure], person: [] },
  });

  await expect(run(false)).rejects.toBe(failure);

  expect(release).toHaveBeenCalledTimes(1);
});
