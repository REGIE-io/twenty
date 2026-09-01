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
} from 'twenty-shared/utils';
import { type DataSource } from 'typeorm';

import {
  decodeCursor,
  encodeCursorData,
} from 'src/engine/api/graphql/graphql-query-runner/utils/cursors.util';
import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { type PhoneSearchResultConnectionDTO } from 'src/engine/core-modules/search/dtos/phone-search-result.dto';
import { type SearchPeopleByPhoneArgs } from 'src/engine/core-modules/search/dtos/search-people-by-phone.args';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { getWorkspaceContext } from 'src/engine/twenty-orm/storage/orm-workspace-context.storage';
import { resolveRolePermissionConfig } from 'src/engine/twenty-orm/utils/resolve-role-permission-config.util';

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
    const person = Object.values(
      flatObjectMetadataMaps.byUniversalIdentifier,
    ).find(
      (object): object is FlatObjectMetadata =>
        isDefined(object) && object.nameSingular === 'person',
    );
    if (!person) return this.emptyConnection();

    return this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const context = getWorkspaceContext();
        const rolePermissionConfig =
          resolveRolePermissionConfig({
            authContext: context.authContext,
            userWorkspaceRoleMap: context.userWorkspaceRoleMap,
            apiKeyRoleMap: context.apiKeyRoleMap,
          }) ?? undefined;
        const repository =
          await this.globalWorkspaceOrmManager.getRepository<ObjectRecord>(
            workspace.id,
            'person',
            rolePermissionConfig,
          );
        const permissions = repository.objectRecordsPermissions?.[person.id];
        if (permissions?.canReadObjectRecords === false)
          return this.emptyConnection();
        const phoneFields = getFlatFieldsFromFlatObjectMetadata(
          person,
          flatFieldMetadataMaps,
        ).filter(
          (field) =>
            field.type === FieldMetadataType.PHONES &&
            field.isActive &&
            isFieldReadable(permissions?.restrictedFields, field.id),
        );
        if (!phoneFields.length) return this.emptyConnection();

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
          [workspace.id, person.id, phoneFields.map((field) => field.id)],
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
        // Keep serving existing ready fields until its generation atomically
        // cuts over. Only the first workspace build has no ready projection to
        // serve and must return a readiness error.
        if (hasMissingOrUnrecoverableState || readyPhoneFields.length === 0) {
          throw new ServiceUnavailableException({
            code: 'PHONE_SEARCH_INDEXING',
            message: 'Phone search is still building for one or more fields',
            retryAfter: 5,
          });
        }
        const readyFieldIds = readyPhoneFields.map((field) => field.id);
        const afterId = args.after
          ? decodeCursor<{ id: string }>(args.after).id
          : undefined;
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

  private emptyConnection(): PhoneSearchResultConnectionDTO {
    return { edges: [], pageInfo: { endCursor: null, hasNextPage: false } };
  }
}
