import { createHash } from 'crypto';

import {
  assertSafeTsVectorExpression,
  escapeIdentifier,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
const FUNCTION_SUFFIX = '_search_vector';
const HASH_LENGTH = 8;

export type SearchVectorTriggerStatements = {
  functionName: string;
  createFunction: string;
  createTrigger: string;
  dropTrigger: string;
};

// Postgres limits identifiers in bytes, so cut whole code points to stay valid UTF-8.
const truncateToByteLength = (value: string, maxByteLength: number): string => {
  let truncated = '';

  for (const character of value) {
    if (Buffer.byteLength(truncated + character, 'utf8') > maxByteLength) {
      break;
    }
    truncated += character;
  }

  return truncated;
};

// Also names the trigger; derived from the table name, so a table rename must rename both.
export const getSearchVectorFunctionName = (tableName: string): string => {
  const plainName = `${tableName}${FUNCTION_SUFFIX}`;

  if (Buffer.byteLength(plainName, 'utf8') <= POSTGRES_IDENTIFIER_MAX_LENGTH) {
    return plainName;
  }

  const hash = createHash('sha1')
    .update(tableName)
    .digest('hex')
    .slice(0, HASH_LENGTH);

  const prefix = truncateToByteLength(
    tableName,
    POSTGRES_IDENTIFIER_MAX_LENGTH - FUNCTION_SUFFIX.length - HASH_LENGTH - 1,
  );

  return `${prefix}${FUNCTION_SUFFIX}_${hash}`;
};

// The expression is checked before it is wrapped: the plpgsql body itself contains ';' and
// '$', which the expression check forbids. Checking the expression guarantees it cannot
// close the $search_vector$ quote.
export const buildSearchVectorTriggerStatements = ({
  schemaName,
  tableName,
  triggerRowExpression,
}: {
  schemaName: string;
  tableName: string;
  triggerRowExpression: string;
}): SearchVectorTriggerStatements => {
  assertSafeTsVectorExpression(triggerRowExpression);

  const functionName = getSearchVectorFunctionName(tableName);
  const qualifiedFunction = `${escapeIdentifier(schemaName)}.${escapeIdentifier(functionName)}`;
  const qualifiedTable = `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;

  return {
    functionName,
    createFunction: `CREATE OR REPLACE FUNCTION ${qualifiedFunction}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $search_vector$
BEGIN
  NEW."searchVector" := ${triggerRowExpression};
  RETURN NEW;
END
$search_vector$`,
    // Not idempotent on its own: run dropTrigger first, in the same transaction.
    createTrigger: `CREATE TRIGGER ${escapeIdentifier(functionName)} BEFORE INSERT OR UPDATE ON ${qualifiedTable} FOR EACH ROW EXECUTE FUNCTION ${qualifiedFunction}()`,
    dropTrigger: `DROP TRIGGER IF EXISTS ${escapeIdentifier(functionName)} ON ${qualifiedTable}`,
  };
};
