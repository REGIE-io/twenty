import { type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

import { CustomException } from 'src/utils/custom-exception';

export class SchemaApplyException extends CustomException<SchemaApplyExceptionCode> {
  constructor(
    message: string,
    code: SchemaApplyExceptionCode,
    { userFriendlyMessage }: { userFriendlyMessage?: MessageDescriptor } = {},
  ) {
    super(message, code, {
      userFriendlyMessage:
        userFriendlyMessage ?? msg`The schema could not be applied.`,
    });
  }
}

export enum SchemaApplyExceptionCode {
  INVALID_SCHEMA_INPUT = 'INVALID_SCHEMA_INPUT',
  OBJECT_NOT_FOUND = 'OBJECT_NOT_FOUND',
  FIELD_NOT_FOUND = 'FIELD_NOT_FOUND',
  SCHEMA_CONFLICT = 'SCHEMA_CONFLICT',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
}
