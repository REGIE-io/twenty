import {
  type FieldMetadataDefaultOption,
  FieldMetadataType,
} from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { type QueryRunner } from 'typeorm';

import {
  ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL,
  type SearchVectorBackfillJobFilter,
  type SearchVectorBackfillJobReason,
  type SearchVectorBackfillJobStatus,
} from 'src/engine/core-modules/search-vector-trigger/entities/search-vector-backfill-job.entity';
import { type SearchVectorTriggerSource } from 'src/engine/core-modules/search-vector-trigger/utils/search-vector-trigger-maintenance.util';
import { type AllFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-maps.type';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { isNullEquivalentTextDefaultValue } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-null-equivalent-text-default-value.util';
import { getSearchedColumnNamesForField } from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';
import { type AllUniversalWorkspaceMigrationAction } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/types/workspace-migration-action-common';

// One field joining or leaving an object's search list in a migration.
export type SearchListChange = {
  tsVectorFieldUniversalIdentifier: string;
  change: 'added' | 'removed';
  fieldLifecycle: 'created' | 'deleted' | 'existing';
  // Only set for a field that existed before the migration.
  fieldMetadataId?: string;
  hasSearchableDefaultValue: boolean;
  hasOptionsUpdate: boolean;
};

export type SearchVectorBackfillChange =
  | { type: 'searchList'; searchListChanges: SearchListChange[] }
  | { type: 'formula' }
  | { type: 'fieldDelete'; fieldMetadataId: string }
  | {
      type: 'options';
      fieldMetadataId: string;
      fromOptions: FieldMetadataDefaultOption[];
      toOptions: FieldMetadataDefaultOption[];
    };

export type SearchVectorBackfillRequest = {
  reason: SearchVectorBackfillJobReason;
  filter: SearchVectorBackfillJobFilter | null;
};

const PHONE_CODE_PROPERTY_NAMES = [
  'primaryPhoneCallingCode',
  'primaryPhoneCountryCode',
];

const hasNonEmptyDefaultValue = (defaultValue: unknown): boolean => {
  if (!isDefined(defaultValue)) {
    return false;
  }

  if (typeof defaultValue === 'string') {
    return !isNullEquivalentTextDefaultValue(defaultValue);
  }

  if (Array.isArray(defaultValue)) {
    return defaultValue.some(hasNonEmptyDefaultValue);
  }

  if (typeof defaultValue === 'object') {
    return Object.values(defaultValue).some(hasNonEmptyDefaultValue);
  }

  return true;
};

// A default stamps every existing row, so it changes words; Twenty's empty-string defaults do not.
// A phone default holding only a calling or country code counts as none: a new phone field never rewrites the table.
export const hasSearchableDefaultValue = ({
  type,
  defaultValue,
}: {
  type: FieldMetadataType;
  defaultValue: unknown;
}): boolean => {
  if (
    type === FieldMetadataType.PHONES &&
    isDefined(defaultValue) &&
    typeof defaultValue === 'object'
  ) {
    return Object.entries(defaultValue).some(
      ([propertyName, propertyDefaultValue]) =>
        !PHONE_CODE_PROPERTY_NAMES.includes(propertyName) &&
        hasNonEmptyDefaultValue(propertyDefaultValue),
    );
  }

  return hasNonEmptyDefaultValue(defaultValue);
};

// Upgrade commands that change the formula (2-18, 2-20) send only rebuild markers. Anything else in
// the migration, such as a rename or a search-list change, is what the rebuild follows from.
export const isSearchVectorFormulaChange = (
  actions: AllUniversalWorkspaceMigrationAction[],
): boolean =>
  actions.length > 0 &&
  actions.every(
    (action) =>
      action.metadataName === 'fieldMetadata' &&
      action.type === 'update' &&
      action.rebuildSearchVector === true,
  );

// Read before the migration runs, while removed search rows can still be resolved.
export const collectSearchListChanges = ({
  actions,
  allFlatEntityMaps,
}: {
  actions: AllUniversalWorkspaceMigrationAction[];
  allFlatEntityMaps: Partial<AllFlatEntityMaps>;
}): SearchListChange[] => {
  const createdFieldByUniversalIdentifier = new Map<
    string,
    { type: FieldMetadataType; defaultValue: unknown }
  >();
  const deletedFieldUniversalIdentifiers = new Set<string>();
  const fieldUniversalIdentifiersWithOptionsUpdate = new Set<string>();

  for (const action of actions) {
    if (action.metadataName !== 'fieldMetadata') {
      continue;
    }

    if (action.type === 'create') {
      createdFieldByUniversalIdentifier.set(
        action.flatEntity.universalIdentifier,
        action.flatEntity,
      );
    } else if (action.type === 'delete') {
      deletedFieldUniversalIdentifiers.add(action.universalIdentifier);
    } else if (action.update.options !== undefined) {
      fieldUniversalIdentifiersWithOptionsUpdate.add(
        action.universalIdentifier,
      );
    }
  }

  const describeChange = ({
    fieldUniversalIdentifier,
    tsVectorFieldUniversalIdentifier,
    change,
  }: {
    fieldUniversalIdentifier: string;
    tsVectorFieldUniversalIdentifier: string;
    change: SearchListChange['change'];
  }): SearchListChange => {
    const createdField = createdFieldByUniversalIdentifier.get(
      fieldUniversalIdentifier,
    );
    const isCreated = isDefined(createdField);

    return {
      tsVectorFieldUniversalIdentifier,
      change,
      fieldLifecycle: isCreated
        ? 'created'
        : deletedFieldUniversalIdentifiers.has(fieldUniversalIdentifier)
          ? 'deleted'
          : 'existing',
      fieldMetadataId: isCreated
        ? undefined
        : allFlatEntityMaps.flatFieldMetadataMaps?.byUniversalIdentifier[
            fieldUniversalIdentifier
          ]?.id,
      hasSearchableDefaultValue:
        isCreated && hasSearchableDefaultValue(createdField),
      hasOptionsUpdate: fieldUniversalIdentifiersWithOptionsUpdate.has(
        fieldUniversalIdentifier,
      ),
    };
  };

  return actions.flatMap((action): SearchListChange[] => {
    if (action.metadataName !== 'searchFieldMetadata') {
      return [];
    }

    if (action.type === 'create') {
      return [
        describeChange({
          fieldUniversalIdentifier:
            action.flatEntity.fieldMetadataUniversalIdentifier,
          tsVectorFieldUniversalIdentifier:
            action.flatEntity.tsVectorFieldMetadataUniversalIdentifier,
          change: 'added',
        }),
      ];
    }

    if (action.type === 'delete') {
      const removedSearchFieldMetadata =
        action.flatEntity ??
        allFlatEntityMaps.flatSearchFieldMetadataMaps?.byUniversalIdentifier[
          action.universalIdentifier
        ];

      if (!isDefined(removedSearchFieldMetadata)) {
        return [];
      }

      return [
        describeChange({
          fieldUniversalIdentifier:
            removedSearchFieldMetadata.fieldMetadataUniversalIdentifier,
          tsVectorFieldUniversalIdentifier:
            removedSearchFieldMetadata.tsVectorFieldMetadataUniversalIdentifier,
          change: 'removed',
        }),
      ];
    }

    return [];
  });
};

const decideSearchListRequest = (
  searchListChange: SearchListChange,
): SearchVectorBackfillRequest | undefined => {
  const { change, fieldLifecycle, fieldMetadataId } = searchListChange;

  if (fieldLifecycle === 'created') {
    // A new field's column is empty on every row unless its default fills it.
    return searchListChange.hasSearchableDefaultValue
      ? { reason: 'DEFAULT_VALUE', filter: null }
      : undefined;
  }

  if (fieldLifecycle === 'deleted' || !isDefined(fieldMetadataId)) {
    return { reason: 'FIELD_DELETE', filter: null };
  }

  if (change === 'added') {
    return { reason: 'RESTORE', filter: { fieldMetadataId } };
  }

  // Values removed from the dropdown in the same migration are already gone from the rows.
  return {
    reason: 'ARCHIVE',
    filter: searchListChange.hasOptionsUpdate ? null : { fieldMetadataId },
  };
};

const decideOptionsRequest = ({
  fieldMetadataId,
  fromOptions,
  toOptions,
}: Extract<SearchVectorBackfillChange, { type: 'options' }>):
  | SearchVectorBackfillRequest
  | undefined => {
  const optionKey = (option: FieldMetadataDefaultOption) =>
    option.id ?? option.value;
  const toOptionByKey = new Map(
    toOptions.map((option) => [optionKey(option), option]),
  );

  // Rows that held a removed value were rewritten without it, so no filter can find them.
  if (fromOptions.some((option) => !toOptionByKey.has(optionKey(option)))) {
    return { reason: 'OPTION_CHANGE', filter: null };
  }

  const changedOptionValues = fromOptions.flatMap((fromOption) => {
    const toOption = toOptionByKey.get(optionKey(fromOption));

    return isDefined(toOption) &&
      (toOption.label !== fromOption.label ||
        toOption.value !== fromOption.value)
      ? [toOption.value]
      : [];
  });

  return changedOptionValues.length > 0
    ? {
        reason: 'OPTION_CHANGE',
        filter: { fieldMetadataId, optionValues: changedOptionValues },
      }
    : undefined;
};

// Only changes that alter the words of existing rows need a backfill; renames never do.
export const decideSearchVectorBackfillRequests = ({
  change,
  searchedFieldMetadataIds,
}: {
  change: SearchVectorBackfillChange;
  searchedFieldMetadataIds: Set<string>;
}): SearchVectorBackfillRequest[] => {
  // A field dropped while still searched; usually its search row goes first, as a search-list change.
  if (change.type === 'fieldDelete') {
    return searchedFieldMetadataIds.has(change.fieldMetadataId)
      ? [{ reason: 'FIELD_DELETE', filter: null }]
      : [];
  }

  // The function was replaced with a new formula, so every row's words are stale.
  if (change.type === 'formula') {
    return [{ reason: 'FORMULA_CHANGE', filter: null }];
  }

  if (change.type === 'options') {
    if (!searchedFieldMetadataIds.has(change.fieldMetadataId)) {
      return [];
    }

    const request = decideOptionsRequest(change);

    return isDefined(request) ? [request] : [];
  }

  return change.searchListChanges
    .map(decideSearchListRequest)
    .filter(isDefined);
};

// Widens to cover both: the same field keeps a filter, anything else becomes the whole table.
export const mergeSearchVectorBackfillFilters = (
  existingFilter: SearchVectorBackfillJobFilter | null,
  newFilter: SearchVectorBackfillJobFilter | null,
): SearchVectorBackfillJobFilter | null => {
  if (
    !isDefined(existingFilter) ||
    !isDefined(newFilter) ||
    existingFilter.fieldMetadataId !== newFilter.fieldMetadataId
  ) {
    return null;
  }

  if (
    !isDefined(existingFilter.optionValues) ||
    !isDefined(newFilter.optionValues)
  ) {
    return { fieldMetadataId: existingFilter.fieldMetadataId };
  }

  return {
    fieldMetadataId: existingFilter.fieldMetadataId,
    optionValues: [
      ...new Set([...existingFilter.optionValues, ...newFilter.optionValues]),
    ],
  };
};

// A JSON null would not read back as "no filter", so a whole-table job stores SQL NULL.
const toFilterParameter = (filter: SearchVectorBackfillJobFilter | null) =>
  isDefined(filter) ? JSON.stringify(filter) : null;

// Runs in the caller's transaction, so the job commits or rolls back with the schema change.
// An active job is restarted rather than duplicated: the function changed, so its done rows are stale.
export const upsertSearchVectorBackfillJob = async (
  queryRunner: QueryRunner,
  {
    workspaceId,
    objectMetadataId,
    request,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    request: SearchVectorBackfillRequest;
  },
): Promise<void> => {
  // cutoffAt is only a placeholder for NOT NULL: the claim that starts the run records its start.
  const insertedJobs = (await queryRunner.query(
    `INSERT INTO core."searchVectorBackfillJob"
       ("workspaceId", "objectMetadataId", "reason", "filter", "cutoffAt")
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT ("workspaceId", "objectMetadataId")
       WHERE "status" IN (${ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL})
       DO NOTHING
     RETURNING "id"`,
    [
      workspaceId,
      objectMetadataId,
      request.reason,
      toFilterParameter(request.filter),
    ],
  )) as Array<{ id: string }>;

  if (insertedJobs.length > 0) {
    return;
  }

  const [activeJob] = (await queryRunner.query(
    `SELECT "id", "filter" FROM core."searchVectorBackfillJob"
      WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
        AND "status" IN (${ACTIVE_SEARCH_VECTOR_BACKFILL_JOB_STATUSES_SQL})
      FOR UPDATE`,
    [workspaceId, objectMetadataId],
  )) as Array<{ id: string; filter: SearchVectorBackfillJobFilter | null }>;

  if (!isDefined(activeJob)) {
    return;
  }

  // The new generation stops a batch already in flight from saving its cursor over this reset.
  await queryRunner.query(
    `UPDATE core."searchVectorBackfillJob"
        SET "status" = 'PENDING', "reason" = $2, "filter" = $3::jsonb,
            "cursor" = NULL, "attempts" = 0,
            "processedRowCount" = 0, "leaseExpiresAt" = NULL, "lastError" = NULL,
            "generation" = "generation" + 1, "updatedAt" = now()
      WHERE "id" = $1`,
    [
      activeJob.id,
      request.reason,
      toFilterParameter(
        mergeSearchVectorBackfillFilters(activeJob.filter, request.filter),
      ),
    ],
  );
};

export const createSearchVectorBackfillJobs = async ({
  source,
  change,
}: {
  source: SearchVectorTriggerSource;
  change: SearchVectorBackfillChange;
}): Promise<void> => {
  const requests = decideSearchVectorBackfillRequests({
    change,
    searchedFieldMetadataIds: new Set(
      source.targetSearchFieldMetadatas.map(
        (searchFieldMetadata) => searchFieldMetadata.fieldMetadataId,
      ),
    ),
  });

  for (const request of requests) {
    await upsertSearchVectorBackfillJob(source.queryRunner, {
      workspaceId: source.flatObjectMetadata.workspaceId,
      objectMetadataId: source.flatObjectMetadata.id,
      request,
    });
  }
};

export const SEARCH_VECTOR_BACKFILL_MAX_RUNNING_JOBS = 5;

// Each running job holds its workspace, and the fleet runs at most a few at once.
export const selectSearchVectorBackfillJobsToClaim = <
  TJob extends { workspaceId: string; status: SearchVectorBackfillJobStatus },
>(
  activeJobsOldestFirst: TJob[],
): TJob[] => {
  const runningJobs = activeJobsOldestFirst.filter(
    (job) => job.status === 'RUNNING',
  );
  const busyWorkspaceIds = new Set(runningJobs.map((job) => job.workspaceId));
  let freeSlotCount =
    SEARCH_VECTOR_BACKFILL_MAX_RUNNING_JOBS - runningJobs.length;
  const jobsToClaim: TJob[] = [];

  for (const job of activeJobsOldestFirst) {
    if (freeSlotCount <= 0) {
      break;
    }

    if (job.status === 'RUNNING' || busyWorkspaceIds.has(job.workspaceId)) {
      continue;
    }

    jobsToClaim.push(job);
    busyWorkspaceIds.add(job.workspaceId);
    freeSlotCount -= 1;
  }

  return jobsToClaim;
};

// Returns a SQL placeholder for the value, numbered after the parameters already added.
export type AddQueryParameter = (value: unknown) => string;

// Option values narrow a dropdown to the rows holding them; otherwise any row with a value in
// the columns the search expression reads (e.g. a phone's calling code on its own).
export const buildSearchVectorBackfillFilterSql = ({
  flatFieldMetadata,
  optionValues,
  addParameter,
}: {
  flatFieldMetadata: Pick<FlatFieldMetadata, 'name' | 'type'>;
  optionValues?: string[];
  addParameter: AddQueryParameter;
}): string => {
  const column = escapeIdentifier(flatFieldMetadata.name);

  if (isDefined(optionValues)) {
    if (flatFieldMetadata.type === FieldMetadataType.SELECT) {
      return `${column}::text = ANY(${addParameter(optionValues)}::text[])`;
    }

    if (flatFieldMetadata.type === FieldMetadataType.MULTI_SELECT) {
      return `${column}::text[] && ${addParameter(optionValues)}::text[]`;
    }
  }

  const hasValueConditions = getSearchedColumnNamesForField(
    flatFieldMetadata,
  ).map(
    (columnName) =>
      `COALESCE(${escapeIdentifier(columnName)}::text, '') NOT IN ('', '{}', '[]', 'null')`,
  );

  return hasValueConditions.length > 0
    ? `(${hasValueConditions.join(' OR ')})`
    : 'TRUE';
};
