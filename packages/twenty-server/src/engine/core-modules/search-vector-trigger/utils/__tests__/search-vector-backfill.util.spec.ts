import { FieldMetadataType } from 'twenty-shared/types';

import {
  collectSearchListChanges,
  decideSearchVectorBackfillRequests,
  hasSearchableDefaultValue,
  isSearchVectorFormulaChange,
  mergeSearchVectorBackfillFilters,
  type SearchListChange,
  SEARCH_VECTOR_BACKFILL_MAX_RUNNING_JOBS,
  selectSearchVectorBackfillJobsToClaim,
  upsertSearchVectorBackfillJob,
} from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-backfill.util';
import { type AllUniversalWorkspaceMigrationAction } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration-action-common';

const FIELD_ID = 'field-id';
const OTHER_FIELD_ID = 'other-field-id';

const buildSearchListChange = (
  overrides: Partial<SearchListChange>,
): SearchListChange => ({
  tsVectorFieldUniversalIdentifier: 'search-vector',
  change: 'added',
  fieldLifecycle: 'existing',
  fieldMetadataId: FIELD_ID,
  hasSearchableDefaultValue: false,
  hasOptionsUpdate: false,
  ...overrides,
});

const decideForSearchList = (searchListChanges: SearchListChange[]) =>
  decideSearchVectorBackfillRequests({
    change: { type: 'searchList', searchListChanges },
    searchedFieldMetadataIds: new Set([FIELD_ID]),
  });

const GOLD = { id: 'gold', label: 'Gold', value: 'GOLD', position: 0 };
const SILVER = { id: 'silver', label: 'Silver', value: 'SILVER', position: 1 };

const decideForOptions = ({
  toOptions,
  isSearched = true,
}: {
  toOptions: (typeof GOLD)[];
  isSearched?: boolean;
}) =>
  decideSearchVectorBackfillRequests({
    change: {
      type: 'options',
      fieldMetadataId: FIELD_ID,
      fromOptions: [GOLD, SILVER],
      toOptions,
    },
    searchedFieldMetadataIds: new Set(isSearched ? [FIELD_ID] : []),
  });

describe('decideSearchVectorBackfillRequests', () => {
  it('should create no job when the only change is a new empty searchable field', () => {
    expect(
      decideForSearchList([
        buildSearchListChange({
          fieldLifecycle: 'created',
          fieldMetadataId: undefined,
        }),
      ]),
    ).toEqual([]);
  });

  it('should backfill the whole table when a new searchable field has a default', () => {
    expect(
      decideForSearchList([
        buildSearchListChange({
          fieldLifecycle: 'created',
          fieldMetadataId: undefined,
          hasSearchableDefaultValue: true,
        }),
      ]),
    ).toEqual([{ reason: 'DEFAULT_VALUE', filter: null }]);
  });

  it('should backfill rows holding a value when an existing field joins or leaves the search list', () => {
    expect(
      decideForSearchList([
        buildSearchListChange({ change: 'added' }),
        buildSearchListChange({
          change: 'removed',
          fieldMetadataId: OTHER_FIELD_ID,
        }),
      ]),
    ).toEqual([
      { reason: 'RESTORE', filter: { fieldMetadataId: FIELD_ID } },
      { reason: 'ARCHIVE', filter: { fieldMetadataId: OTHER_FIELD_ID } },
    ]);
  });

  it('should backfill the whole table when a removed field also had its options changed', () => {
    expect(
      decideForSearchList([
        buildSearchListChange({ change: 'removed', hasOptionsUpdate: true }),
      ]),
    ).toEqual([{ reason: 'ARCHIVE', filter: null }]);
  });

  it('should backfill the whole table when a searched field is deleted', () => {
    expect(
      decideForSearchList([
        buildSearchListChange({ change: 'removed', fieldLifecycle: 'deleted' }),
      ]),
    ).toEqual([{ reason: 'FIELD_DELETE', filter: null }]);

    expect(
      decideSearchVectorBackfillRequests({
        change: { type: 'fieldDelete', fieldMetadataId: FIELD_ID },
        searchedFieldMetadataIds: new Set([FIELD_ID]),
      }),
    ).toEqual([{ reason: 'FIELD_DELETE', filter: null }]);
  });

  it('should create no job when an unsearched field is deleted', () => {
    expect(
      decideSearchVectorBackfillRequests({
        change: { type: 'fieldDelete', fieldMetadataId: FIELD_ID },
        searchedFieldMetadataIds: new Set(),
      }),
    ).toEqual([]);
  });

  it('should backfill rows holding a relabelled or renamed option value', () => {
    expect(
      decideForOptions({
        toOptions: [
          { ...GOLD, label: 'Platinum' },
          { ...SILVER, value: 'STEEL' },
        ],
      }),
    ).toEqual([
      {
        reason: 'OPTION_CHANGE',
        filter: { fieldMetadataId: FIELD_ID, optionValues: ['GOLD', 'STEEL'] },
      },
    ]);
  });

  it('should backfill the whole table when an option is removed', () => {
    expect(decideForOptions({ toOptions: [GOLD] })).toEqual([
      { reason: 'OPTION_CHANGE', filter: null },
    ]);
  });

  it('should create no job when options only move, are added, or the field is not searched', () => {
    expect(
      decideForOptions({
        toOptions: [
          { ...SILVER, position: 0 },
          { ...GOLD, position: 1 },
          { id: 'bronze', label: 'Bronze', value: 'BRONZE', position: 2 },
        ],
      }),
    ).toEqual([]);
    expect(
      decideForOptions({
        toOptions: [{ ...GOLD, label: 'Platinum' }, SILVER],
        isSearched: false,
      }),
    ).toEqual([]);
  });
});

describe('hasSearchableDefaultValue', () => {
  it('should ignore empty and null defaults, including composite ones', () => {
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.TEXT,
        defaultValue: null,
      }),
    ).toBe(false);
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.TEXT,
        defaultValue: "''",
      }),
    ).toBe(false);
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.EMAILS,
        defaultValue: { primaryEmail: "''", additionalEmails: null },
      }),
    ).toBe(false);
  });

  it('should count any real value', () => {
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.SELECT,
        defaultValue: "'GOLD'",
      }),
    ).toBe(true);
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.MULTI_SELECT,
        defaultValue: ["'GOLD'"],
      }),
    ).toBe(true);
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.PHONES,
        defaultValue: {
          primaryPhoneNumber: "'5550100'",
          primaryPhoneCallingCode: "'+1'",
        },
      }),
    ).toBe(true);
  });

  it('should not count a phone default holding only a calling code', () => {
    expect(
      hasSearchableDefaultValue({
        type: FieldMetadataType.PHONES,
        defaultValue: {
          primaryPhoneNumber: "''",
          primaryPhoneCountryCode: "'US'",
          primaryPhoneCallingCode: "'+1'",
          additionalPhones: null,
        },
      }),
    ).toBe(false);
  });
});

describe('isSearchVectorFormulaChange', () => {
  const rebuildMarker = {
    type: 'update',
    metadataName: 'fieldMetadata',
    universalIdentifier: 'search-vector',
    update: {},
    rebuildSearchVector: true,
  };

  it('should treat a migration of only rebuild markers as a formula change', () => {
    expect(
      isSearchVectorFormulaChange([
        rebuildMarker,
      ] as unknown as AllUniversalWorkspaceMigrationAction[]),
    ).toBe(true);
    expect(
      decideSearchVectorBackfillRequests({
        change: { type: 'formula' },
        searchedFieldMetadataIds: new Set(),
      }),
    ).toEqual([{ reason: 'FORMULA_CHANGE', filter: null }]);
  });

  it('should not when the rebuild follows a rename in the same migration', () => {
    expect(
      isSearchVectorFormulaChange([
        rebuildMarker,
        {
          type: 'update',
          metadataName: 'fieldMetadata',
          universalIdentifier: 'renamed-field',
          update: { name: 'renamed' },
        },
      ] as unknown as AllUniversalWorkspaceMigrationAction[]),
    ).toBe(false);
  });
});

describe('selectSearchVectorBackfillJobsToClaim', () => {
  const job = (workspaceId: string, status: string) => ({
    workspaceId,
    status: status as 'PENDING',
  });

  it('should claim at most one job per workspace and skip busy workspaces', () => {
    expect(
      selectSearchVectorBackfillJobsToClaim([
        job('busy', 'RUNNING'),
        job('busy', 'PENDING'),
        job('a', 'PENDING'),
        job('a', 'RETRYABLE'),
        job('b', 'RETRYABLE'),
      ]),
    ).toEqual([job('a', 'PENDING'), job('b', 'RETRYABLE')]);
  });

  it('should not run more jobs than the fleet limit', () => {
    const runningJobs = Array.from(
      { length: SEARCH_VECTOR_BACKFILL_MAX_RUNNING_JOBS - 1 },
      (_, index) => job(`running-${index}`, 'RUNNING'),
    );

    expect(
      selectSearchVectorBackfillJobsToClaim([
        ...runningJobs,
        job('a', 'PENDING'),
        job('b', 'PENDING'),
      ]),
    ).toEqual([job('a', 'PENDING')]);
  });
});

describe('collectSearchListChanges', () => {
  it('should describe added and removed search rows with their field lifecycle', () => {
    const actions = [
      {
        type: 'create',
        metadataName: 'fieldMetadata',
        flatEntity: { universalIdentifier: 'new-field', defaultValue: "''" },
      },
      {
        type: 'delete',
        metadataName: 'fieldMetadata',
        universalIdentifier: 'deleted-field',
      },
      {
        type: 'update',
        metadataName: 'fieldMetadata',
        universalIdentifier: 'archived-field',
        update: { options: [] },
      },
      {
        type: 'create',
        metadataName: 'searchFieldMetadata',
        flatEntity: {
          fieldMetadataUniversalIdentifier: 'new-field',
          tsVectorFieldMetadataUniversalIdentifier: 'search-vector',
        },
      },
      {
        type: 'delete',
        metadataName: 'searchFieldMetadata',
        universalIdentifier: 'deleted-field-search-row',
      },
      {
        type: 'delete',
        metadataName: 'searchFieldMetadata',
        universalIdentifier: 'archived-field-search-row',
      },
    ] as unknown as AllUniversalWorkspaceMigrationAction[];

    const searchRow = (fieldMetadataUniversalIdentifier: string) => ({
      fieldMetadataUniversalIdentifier,
      tsVectorFieldMetadataUniversalIdentifier: 'search-vector',
    });

    expect(
      collectSearchListChanges({
        actions,
        allFlatEntityMaps: {
          flatSearchFieldMetadataMaps: {
            byUniversalIdentifier: {
              'deleted-field-search-row': searchRow('deleted-field'),
              'archived-field-search-row': searchRow('archived-field'),
            },
          },
          flatFieldMetadataMaps: {
            byUniversalIdentifier: {
              'deleted-field': { id: 'deleted-field-id' },
              'archived-field': { id: 'archived-field-id' },
            },
          },
        } as never,
      }),
    ).toEqual([
      buildSearchListChange({
        change: 'added',
        fieldLifecycle: 'created',
        fieldMetadataId: undefined,
      }),
      buildSearchListChange({
        change: 'removed',
        fieldLifecycle: 'deleted',
        fieldMetadataId: 'deleted-field-id',
      }),
      buildSearchListChange({
        change: 'removed',
        fieldMetadataId: 'archived-field-id',
        hasOptionsUpdate: true,
      }),
    ]);
  });
});

describe('mergeSearchVectorBackfillFilters', () => {
  it('should widen to the whole table unless both filters target the same field', () => {
    expect(
      mergeSearchVectorBackfillFilters(null, { fieldMetadataId: FIELD_ID }),
    ).toBeNull();
    expect(
      mergeSearchVectorBackfillFilters(
        { fieldMetadataId: FIELD_ID },
        { fieldMetadataId: OTHER_FIELD_ID },
      ),
    ).toBeNull();
  });

  it('should keep a filter on the same field, joining option values', () => {
    expect(
      mergeSearchVectorBackfillFilters(
        { fieldMetadataId: FIELD_ID, optionValues: ['GOLD'] },
        { fieldMetadataId: FIELD_ID, optionValues: ['SILVER', 'GOLD'] },
      ),
    ).toEqual({ fieldMetadataId: FIELD_ID, optionValues: ['GOLD', 'SILVER'] });
    expect(
      mergeSearchVectorBackfillFilters(
        { fieldMetadataId: FIELD_ID, optionValues: ['GOLD'] },
        { fieldMetadataId: FIELD_ID },
      ),
    ).toEqual({ fieldMetadataId: FIELD_ID });
  });
});

describe('upsertSearchVectorBackfillJob', () => {
  const upsert = (queryRunner: { query: jest.Mock }) =>
    upsertSearchVectorBackfillJob(queryRunner as never, {
      workspaceId: 'workspace-id',
      objectMetadataId: 'object-id',
      request: {
        reason: 'OPTION_CHANGE',
        filter: { fieldMetadataId: FIELD_ID, optionValues: ['SILVER'] },
      },
    });

  it('should insert a new job when the table has no active one', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([{ id: 'job' }]) };

    await upsert(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).toContain('ON CONFLICT');
  });

  it('should restart the active job from the beginning with a widened filter', async () => {
    const queryRunner = {
      query: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'active-job',
            filter: { fieldMetadataId: FIELD_ID, optionValues: ['GOLD'] },
          },
        ])
        .mockResolvedValueOnce([]),
    };

    await upsert(queryRunner);

    const [resetSql, resetParameters] = queryRunner.query.mock.calls[2];

    expect(resetSql).toContain(`"status" = 'PENDING'`);
    expect(resetSql).toContain(`"cursor" = NULL`);
    expect(resetSql).toContain(`"attempts" = 0`);
    expect(resetSql).toContain(`"generation" = "generation" + 1`);
    // The claim that starts the next run takes the cutoff.
    expect(resetSql).not.toContain(`"cutoffAt"`);
    expect(resetParameters).toEqual([
      'active-job',
      'OPTION_CHANGE',
      JSON.stringify({
        fieldMetadataId: FIELD_ID,
        optionValues: ['GOLD', 'SILVER'],
      }),
    ]);
  });

  it('should store a whole-table filter as SQL NULL', async () => {
    const queryRunner = { query: jest.fn().mockResolvedValue([{ id: 'job' }]) };

    await upsertSearchVectorBackfillJob(queryRunner as never, {
      workspaceId: 'workspace-id',
      objectMetadataId: 'object-id',
      request: { reason: 'FIELD_DELETE', filter: null },
    });

    expect(queryRunner.query.mock.calls[0][1][3]).toBeNull();
  });
});
