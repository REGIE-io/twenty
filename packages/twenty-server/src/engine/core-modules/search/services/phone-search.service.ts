import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { FieldMetadataType, type ObjectRecord } from 'twenty-shared/types';
import {
  canonicalizeE164PhoneSearchInput,
  isDefined,
  isFieldReadable,
  isValidUuid,
} from 'twenty-shared/utils';
import { type DataSource } from 'typeorm';

import {
  decodeCursor,
  encodeCursorData,
} from 'src/engine/api/graphql/graphql-query-runner/utils/cursors.util';
import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { type PhoneSearchResultConnectionDTO } from 'src/engine/core-modules/search/dtos/phone-search-result.dto';
import {
  PhoneSearchLookupStatus,
  type BulkPhoneSearchResultDTO,
} from 'src/engine/core-modules/search/dtos/bulk-phone-search-result.dto';
import { type SearchPeopleByPhoneArgs } from 'src/engine/core-modules/search/dtos/search-people-by-phone.args';
import { type SearchPeopleByPhonesArgs } from 'src/engine/core-modules/search/dtos/search-people-by-phones.args';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { type WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';

export const decodePhoneSearchCursor = (cursor: string): string => {
  const cursorData = decodeCursor<unknown>(cursor);

  if (
    cursorData === null ||
    typeof cursorData !== 'object' ||
    Array.isArray(cursorData) ||
    !('id' in cursorData) ||
    typeof cursorData.id !== 'string' ||
    !isValidUuid(cursorData.id)
  ) {
    throw new BadRequestException('Invalid phone search cursor');
  }

  return cursorData.id;
};

type PhoneSearchQueryContext = {
  repository: WorkspaceRepository<ObjectRecord>;
  readyFieldIds: string[];
};

type BulkPhoneMatchRow = {
  canonicalPhone: string;
  recordId: string;
};

const INVALID_PHONE_NUMBER_MESSAGE =
  'Phone number must be a valid E.164 international phone number';

@Injectable()
export class PhoneSearchService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async searchPeopleByPhone({
    workspace,
    args,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
  }: {
    workspace: WorkspaceEntity;
    args: SearchPeopleByPhoneArgs;
    flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
    flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  }): Promise<PhoneSearchResultConnectionDTO> {
    const phoneDigits = canonicalizeE164PhoneSearchInput(args.phoneNumber);
    if (!phoneDigits)
      throw new BadRequestException(
        'phoneNumber must be a valid E.164 international phone number',
      );
    const afterId = args.after
      ? decodePhoneSearchCursor(args.after)
      : undefined;
    const person = Object.values(
      flatObjectMetadataMaps.byUniversalIdentifier,
    ).find(
      (object): object is FlatObjectMetadata =>
        isDefined(object) && object.nameSingular === 'person',
    );
    if (!person) return this.emptyConnection();

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const queryContext = await this.preparePhoneSearchQueryContext({
          workspaceId: workspace.id,
          person,
          flatFieldMetadataMaps,
        });

        if (!queryContext) return this.emptyConnection();

        const { repository, readyFieldIds } = queryContext;
        // Person remains the outer, permission-aware relation. Starting with
        // lookup candidate IDs and fetching Persons in a second query could
        // bypass row-level predicates or make pagination permission-unstable.
        const queryBuilder = repository
          .createQueryBuilder('person')
          .select('"person"."id"', 'id')
          .andWhere('"person"."deletedAt" IS NULL')
          .andWhere(
            `EXISTS (
              SELECT 1
              FROM core."personPhoneLookup" lookup
              INNER JOIN core."phoneSearchFieldState" state
                ON state."workspaceId" = lookup."workspaceId"
               AND state."objectMetadataId" = lookup."objectMetadataId"
               AND state."fieldMetadataId" = lookup."fieldMetadataId"
               AND state."activeProjectionGeneration" = lookup."projectionGeneration"
              WHERE lookup."workspaceId" = :workspaceId
                AND lookup."objectMetadataId" = :objectMetadataId
                AND lookup."recordId" = "person"."id"
                AND lookup."canonicalPhone" = :canonicalPhone
                AND lookup."fieldMetadataId" IN (:...readyFieldIds)
                AND state."isQueryEnabled" = true
            )`,
            {
              workspaceId: workspace.id,
              objectMetadataId: person.id,
              canonicalPhone: phoneDigits,
              readyFieldIds,
            },
          );
        if (afterId)
          queryBuilder.andWhere('"person"."id" > :afterId', { afterId });
        const records = await queryBuilder
          .orderBy('"person"."id"', 'ASC')
          .take(args.limit + 1)
          .getRawMany<{ id: string }>();
        const hasNextPage = records.length > args.limit;
        const page = records.slice(0, args.limit);
        return {
          edges: page.map((record) => ({
            node: { recordId: record.id },
            cursor: encodeCursorData({ id: record.id }),
          })),
          pageInfo: {
            endCursor: page.length
              ? encodeCursorData({ id: page[page.length - 1]?.id })
              : null,
            hasNextPage,
          },
        };
      },
    );
  }

  async searchPeopleByPhones({
    workspace,
    args,
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
  }: {
    workspace: WorkspaceEntity;
    args: SearchPeopleByPhonesArgs;
    flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
    flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  }): Promise<BulkPhoneSearchResultDTO> {
    this.assertUniqueClientReferences(args.lookups);

    const canonicalPhones = args.lookups.map((lookup) =>
      canonicalizeE164PhoneSearchInput(lookup.phoneNumber),
    );
    const uniqueValidPhones = [...new Set(canonicalPhones.filter(isDefined))];

    if (uniqueValidPhones.length === 0) {
      return this.buildBulkResult({
        lookups: args.lookups,
        canonicalPhones,
        matchesByPhone: new Map(),
        matchLimitPerPhone: args.matchLimitPerPhone,
      });
    }

    const person = Object.values(
      flatObjectMetadataMaps.byUniversalIdentifier,
    ).find(
      (object): object is FlatObjectMetadata =>
        isDefined(object) && object.nameSingular === 'person',
    );

    if (!person) {
      return this.buildBulkResult({
        lookups: args.lookups,
        canonicalPhones,
        matchesByPhone: new Map(),
        matchLimitPerPhone: args.matchLimitPerPhone,
      });
    }

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const queryContext = await this.preparePhoneSearchQueryContext({
          workspaceId: workspace.id,
          person,
          flatFieldMetadataMaps,
        });

        if (!queryContext) {
          return this.buildBulkResult({
            lookups: args.lookups,
            canonicalPhones,
            matchesByPhone: new Map(),
            matchLimitPerPhone: args.matchLimitPerPhone,
          });
        }

        const rows = await this.findBulkPhoneMatches({
          workspaceId: workspace.id,
          objectMetadataId: person.id,
          canonicalPhones: uniqueValidPhones,
          matchLimitPerPhone: args.matchLimitPerPhone,
          ...queryContext,
        });
        const matchesByPhone = new Map<string, string[]>();

        for (const row of rows) {
          const matches = matchesByPhone.get(row.canonicalPhone) ?? [];

          matches.push(row.recordId);
          matchesByPhone.set(row.canonicalPhone, matches);
        }

        return this.buildBulkResult({
          lookups: args.lookups,
          canonicalPhones,
          matchesByPhone,
          matchLimitPerPhone: args.matchLimitPerPhone,
        });
      },
    );
  }

  private async preparePhoneSearchQueryContext({
    workspaceId,
    person,
    flatFieldMetadataMaps,
  }: {
    workspaceId: string;
    person: FlatObjectMetadata;
    flatFieldMetadataMaps: FlatEntityMaps<FlatFieldMetadata>;
  }): Promise<PhoneSearchQueryContext | undefined> {
    const context = getWorkspaceContext();
    const rolePermissionConfig =
      resolveRolePermissionConfig({
        authContext: context.authContext,
        userWorkspaceRoleMap: context.userWorkspaceRoleMap,
        apiKeyRoleMap: context.apiKeyRoleMap,
      }) ?? undefined;
    const repository =
      await this.globalWorkspaceOrmManager.getRepository<ObjectRecord>(
        workspaceId,
        'person',
        rolePermissionConfig,
      );
    const permissions = repository.objectRecordsPermissions?.[person.id];

    if (permissions?.canReadObjectRecords === false) return undefined;

    const phoneFields = getFlatFieldsFromFlatObjectMetadata(
      person,
      flatFieldMetadataMaps,
    ).filter(
      (field) =>
        field.type === FieldMetadataType.PHONES &&
        field.isActive &&
        isFieldReadable(permissions?.restrictedFields, field.id),
    );

    if (phoneFields.length === 0) return undefined;

    // State is read before the Person query so an empty lookup result is only
    // definitive when every readable phone field has a verified generation.
    // This is also what keeps an old generation serving during a repair.
    const fieldStates = await this.dataSource.query<
      Array<{
        fieldMetadataId: string;
        isQueryEnabled: boolean;
        activeProjectionGeneration: string | null;
        syncStatus: string;
      }>
    >(
      `SELECT "fieldMetadataId", "isQueryEnabled", "activeProjectionGeneration", "syncStatus"
         FROM core."phoneSearchFieldState"
        WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
          AND "fieldMetadataId" = ANY($3::uuid[])`,
      [workspaceId, person.id, phoneFields.map((field) => field.id)],
    );
    const statesByFieldId = new Map(
      fieldStates.map((state) => [state.fieldMetadataId, state]),
    );
    const hasMissingOrUnrecoverableState = phoneFields.some((field) => {
      const state = statesByFieldId.get(field.id);

      return (
        !state ||
        (state.syncStatus === 'FAILED' &&
          state.activeProjectionGeneration === null)
      );
    });
    const readyPhoneFields = phoneFields.filter((field) => {
      const state = statesByFieldId.get(field.id);

      return (
        state?.isQueryEnabled === true &&
        state.activeProjectionGeneration !== null
      );
    });

    // A field being added is staged outside the last complete projection.
    // Keep serving existing ready fields until its generation atomically cuts
    // over. Only the first build has no projection to serve.
    if (hasMissingOrUnrecoverableState || readyPhoneFields.length === 0) {
      throw new ServiceUnavailableException({
        code: 'PHONE_SEARCH_INDEXING',
        message: 'Phone search is still building for one or more fields',
        retryAfter: 5,
      });
    }

    return {
      repository,
      readyFieldIds: readyPhoneFields.map((field) => field.id),
    };
  }

  private async findBulkPhoneMatches({
    repository,
    workspaceId,
    objectMetadataId,
    readyFieldIds,
    canonicalPhones,
    matchLimitPerPhone,
  }: PhoneSearchQueryContext & {
    workspaceId: string;
    objectMetadataId: string;
    canonicalPhones: string[];
    matchLimitPerPhone: number;
  }): Promise<BulkPhoneMatchRow[]> {
    // Build the permitted Person relation through Twenty ORM first. The CTE is
    // then joined to lookup rows, so raw lookup candidates can never bypass
    // object or row-level predicates.
    const permittedPeopleQuery = repository
      .createQueryBuilder('person')
      .select('"person"."id"', 'id')
      .andWhere('"person"."deletedAt" IS NULL');

    permittedPeopleQuery.applyRowLevelPermissionPredicatesToMainAliasAndJoinedRelations();

    const [permittedPeopleSql, permittedPeopleParameters] =
      permittedPeopleQuery.getQueryAndParameters();
    const workspaceParameter = `$${permittedPeopleParameters.length + 1}`;
    const objectParameter = `$${permittedPeopleParameters.length + 2}`;
    const phonesParameter = `$${permittedPeopleParameters.length + 3}`;
    const fieldsParameter = `$${permittedPeopleParameters.length + 4}`;
    const rankParameter = `$${permittedPeopleParameters.length + 5}`;
    const sql = `
      WITH "permittedPeople" AS (${permittedPeopleSql}),
      "visibleMatches" AS (
        SELECT DISTINCT
          lookup."canonicalPhone" AS "canonicalPhone",
          people."id" AS "recordId"
        FROM "permittedPeople" people
        INNER JOIN core."personPhoneLookup" lookup
          ON lookup."recordId" = people."id"
        INNER JOIN core."phoneSearchFieldState" state
          ON state."workspaceId" = lookup."workspaceId"
         AND state."objectMetadataId" = lookup."objectMetadataId"
         AND state."fieldMetadataId" = lookup."fieldMetadataId"
         AND state."activeProjectionGeneration" = lookup."projectionGeneration"
        WHERE lookup."workspaceId" = ${workspaceParameter}
          AND lookup."objectMetadataId" = ${objectParameter}
          AND lookup."canonicalPhone" = ANY(${phonesParameter}::text[])
          AND lookup."fieldMetadataId" = ANY(${fieldsParameter}::uuid[])
          AND state."isQueryEnabled" = true
      ),
      "rankedMatches" AS (
        SELECT
          "canonicalPhone",
          "recordId",
          row_number() OVER (
            PARTITION BY "canonicalPhone"
            ORDER BY "recordId" ASC
          ) AS "matchRank"
        FROM "visibleMatches"
      )
      SELECT "canonicalPhone", "recordId"
      FROM "rankedMatches"
      WHERE "matchRank" <= ${rankParameter}
      ORDER BY "canonicalPhone" ASC, "recordId" ASC
    `;

    return this.dataSource.query<BulkPhoneMatchRow[]>(sql, [
      ...permittedPeopleParameters,
      workspaceId,
      objectMetadataId,
      canonicalPhones,
      readyFieldIds,
      matchLimitPerPhone + 1,
    ]);
  }

  private assertUniqueClientReferences(
    lookups: SearchPeopleByPhonesArgs['lookups'],
  ): void {
    const clientReferences = new Set<string>();

    for (const lookup of lookups) {
      if (lookup.clientReference.trim().length === 0) {
        throw new BadRequestException('clientReference must not be empty');
      }
      if (clientReferences.has(lookup.clientReference)) {
        throw new BadRequestException(
          'clientReference must be unique within a bulk phone search',
        );
      }
      clientReferences.add(lookup.clientReference);
    }
  }

  private buildBulkResult({
    lookups,
    canonicalPhones,
    matchesByPhone,
    matchLimitPerPhone,
  }: {
    lookups: SearchPeopleByPhonesArgs['lookups'];
    canonicalPhones: Array<string | undefined>;
    matchesByPhone: Map<string, string[]>;
    matchLimitPerPhone: number;
  }): BulkPhoneSearchResultDTO {
    return {
      results: lookups.map((lookup, index) => {
        const canonicalPhone = canonicalPhones[index];

        if (!canonicalPhone) {
          return {
            clientReference: lookup.clientReference,
            phoneNumber: lookup.phoneNumber,
            status: PhoneSearchLookupStatus.INVALID,
            matches: [],
            hasMore: false,
            error: {
              code: 'INVALID_PHONE_NUMBER',
              message: INVALID_PHONE_NUMBER_MESSAGE,
            },
          };
        }

        const matches = matchesByPhone.get(canonicalPhone) ?? [];
        const hasMore = matches.length > matchLimitPerPhone;
        const page = matches.slice(0, matchLimitPerPhone);

        return {
          clientReference: lookup.clientReference,
          phoneNumber: lookup.phoneNumber,
          status:
            page.length > 0
              ? PhoneSearchLookupStatus.FOUND
              : PhoneSearchLookupStatus.NOT_FOUND,
          matches: page.map((recordId) => ({ recordId })),
          hasMore,
          error: null,
        };
      }),
    };
  }

  private emptyConnection(): PhoneSearchResultConnectionDTO {
    return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } };
  }
}
