import { type SelectQueryBuilder } from 'typeorm';

import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

export interface AddPersonEmailFiltersToQueryBuilderOptions {
  queryBuilder: SelectQueryBuilder<PersonWorkspaceEntity>;
  emails: string[];
  excludePersonIds?: string[];
}

// Stored emails are lowercase and trimmed, so raw columns can use the primary BTREE
// and additional-emails GIN indexes. jsonb_typeof stops ?| matching an object's keys.
export function addPersonEmailFiltersToQueryBuilder({
  queryBuilder,
  emails,
  excludePersonIds = [],
}: AddPersonEmailFiltersToQueryBuilderOptions): SelectQueryBuilder<PersonWorkspaceEntity> {
  const normalizedEmails = [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];

  queryBuilder = queryBuilder.where(
    `("person"."emailsPrimaryEmail" = ANY(:emails) OR (jsonb_typeof("person"."emailsAdditionalEmails") = 'array' AND "person"."emailsAdditionalEmails" ?| :emails::text[]))`,
    { emails: normalizedEmails },
  );

  if (excludePersonIds.length > 0) {
    queryBuilder = queryBuilder.andWhere(
      '"person"."id" NOT IN (:...excludePersonIds)',
      { excludePersonIds },
    );
  }

  return queryBuilder.withDeleted();
}
