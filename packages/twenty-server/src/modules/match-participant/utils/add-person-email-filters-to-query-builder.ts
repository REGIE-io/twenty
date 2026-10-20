import { type SelectQueryBuilder, type ObjectLiteral } from 'typeorm';
import { type WorkspaceSelectQueryBuilder } from 'src/engine/twenty-orm/query-builder/workspace-select-query-builder';

type EmailPredicateQueryBuilder =
  | Pick<WorkspaceSelectQueryBuilder, 'where' | 'andWhere' | 'withDeleted'>
  | Pick<
      SelectQueryBuilder<ObjectLiteral>,
      'where' | 'andWhere' | 'withDeleted'
    >;

export interface AddPersonEmailFiltersToQueryBuilderOptions<
  T extends EmailPredicateQueryBuilder,
> {
  queryBuilder: T;
  emails: string[];
  excludePersonIds?: string[];
}

// Stored emails are lowercase and trimmed, so raw columns can use the primary BTREE
// and additional-emails GIN indexes. jsonb_typeof stops ?| matching an object's keys.
export function addPersonEmailFiltersToQueryBuilder<
  T extends EmailPredicateQueryBuilder,
>({
  queryBuilder,
  emails,
  excludePersonIds = [],
}: AddPersonEmailFiltersToQueryBuilderOptions<T>): T {
  const normalizedEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];

  queryBuilder.where(
    `("person"."emailsPrimaryEmail" = ANY(:emails) OR (jsonb_typeof("person"."emailsAdditionalEmails") = 'array' AND "person"."emailsAdditionalEmails" ?| :emails::text[]))`,
    { emails: normalizedEmails },
  );

  if (excludePersonIds.length > 0) {
    queryBuilder.andWhere('"person"."id" NOT IN (:...excludePersonIds)', {
      excludePersonIds,
    });
  }

  queryBuilder.withDeleted();
  return queryBuilder;
}
