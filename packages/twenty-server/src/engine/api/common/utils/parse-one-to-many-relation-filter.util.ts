export type OneToManyRelationCollectionOperator = 'some' | 'none';

/**
 * Keeps the API-argument and GraphQL query paths on the same one-to-many
 * relation-filter contract. Each caller maps an invalid result to its own
 * transport-specific exception.
 */
export const parseOneToManyRelationFilter = (
  value: unknown,
): { operator: OneToManyRelationCollectionOperator; targetFilter: object } | null => {
  if (typeof value !== 'object' || value === null) return null;

  const entries = Object.entries(value);
  const [operator, targetFilter] = entries[0] ?? [];

  if (
    entries.length !== 1 ||
    (operator !== 'some' && operator !== 'none') ||
    typeof targetFilter !== 'object' ||
    targetFilter === null
  ) {
    return null;
  }

  return { operator, targetFilter };
};
