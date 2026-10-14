import { assertUnreachable } from 'twenty-shared/utils';

import { SchemaApplyExceptionCode } from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';

export const schemaApplyExceptionCodeToHttpStatus = (
  code: SchemaApplyExceptionCode,
): number => {
  switch (code) {
    case SchemaApplyExceptionCode.INVALID_SCHEMA_INPUT:
      return 400;
    case SchemaApplyExceptionCode.OBJECT_NOT_FOUND:
    case SchemaApplyExceptionCode.FIELD_NOT_FOUND:
      return 404;
    case SchemaApplyExceptionCode.SCHEMA_CONFLICT:
      return 409;
    case SchemaApplyExceptionCode.INTERNAL_SERVER_ERROR:
      return 500;
    default:
      return assertUnreachable(code);
  }
};
