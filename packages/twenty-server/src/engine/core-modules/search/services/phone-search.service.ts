import { BadRequestException, Injectable } from '@nestjs/common';

import { parsePhoneNumberWithError } from 'libphonenumber-js';
import { FieldMetadataType, type ObjectRecord } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

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

const canonicalizePhoneNumber = ({
  phoneNumber,
  countryCode,
}: Pick<SearchPeopleByPhoneArgs, 'phoneNumber' | 'countryCode'>): string => {
  try {
    if (!phoneNumber.trim().startsWith('+') && !countryCode) throw new Error();
    const parsed = parsePhoneNumberWithError(phoneNumber, {
      defaultCountry: countryCode as never,
    });
    if (!parsed.isValid()) throw new Error();
    return `${parsed.countryCallingCode}${parsed.nationalNumber}`;
  } catch {
    throw new BadRequestException('phoneNumber must be a valid phone number');
  }
};

@Injectable()
export class PhoneSearchService {
  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
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
    const phoneDigits = canonicalizePhoneNumber(args);
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
            permissions?.restrictedFields?.[field.id]?.canRead !== false,
        );
        if (!phoneFields.length) return this.emptyConnection();

        const afterId = args.after
          ? decodeCursor<{ id: string }>(args.after).id
          : undefined;
        const qualifiedPhoneQuery = phoneFields
          .map(
            (field) =>
              `f${field.universalIdentifier.replaceAll('-', '')}p${phoneDigits}`,
          )
          .join(' | ');
        const queryBuilder = repository
          .createQueryBuilder('person')
          .select('"person"."id"', 'id')
          .andWhere('"person"."deletedAt" IS NULL')
          .andWhere(
            '"person"."phoneSearchVector" @@ to_tsquery(\'simple\', :qualifiedPhoneQuery)',
            { qualifiedPhoneQuery },
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
              ? encodeCursorData({ id: page.at(-1)?.id })
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
