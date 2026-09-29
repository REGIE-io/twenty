import { type SelectQueryBuilder } from 'typeorm';

import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

export interface AddPersonEmailFiltersToQueryBuilderOptions {
  queryBuilder: SelectQueryBuilder<PersonWorkspaceEntity>;
  emails: string[];
  excludePersonIds?: string[];
}

// A query builder rather than find(): matching additional emails needs the jsonb @> operator
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
    `(LOWER(TRIM("person"."emailsPrimaryEmail")) = ANY(:emails) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof("person"."emailsAdditionalEmails") = 'array'
          THEN "person"."emailsAdditionalEmails" ELSE '[]'::jsonb END
      ) AS address(value) WHERE LOWER(TRIM(address.value)) = ANY(:emails)
    ))`,
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
