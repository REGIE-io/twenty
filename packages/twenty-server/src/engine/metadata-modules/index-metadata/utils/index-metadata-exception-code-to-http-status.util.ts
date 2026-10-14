import { assertUnreachable } from 'twenty-shared/utils';

import { IndexMetadataExceptionCode } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';

export const indexMetadataExceptionCodeToHttpStatus = (
  code: IndexMetadataExceptionCode,
): number => {
  switch (code) {
    case IndexMetadataExceptionCode.INDEX_OBJECT_NOT_FOUND:
    case IndexMetadataExceptionCode.INDEX_NOT_FOUND:
      return 404;
    case IndexMetadataExceptionCode.INDEX_FIELDS_REQUIRED:
    case IndexMetadataExceptionCode.DUPLICATE_INDEX_FIELDS:
    case IndexMetadataExceptionCode.INDEX_FIELD_NOT_FOUND_ON_OBJECT:
    case IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_COMPOSITE_FIELD:
    case IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_MORH_RELATION_FIELD_AND_RELATION_FIELD:
    case IndexMetadataExceptionCode.INDEX_TYPE_NOT_SUPPORTED_FOR_FIELD_TYPE:
    case IndexMetadataExceptionCode.DUPLICATE_UNIQUE_INDEX:
      return 400;
    case IndexMetadataExceptionCode.CANNOT_DELETE_SYSTEM_INDEX:
      return 403;
    case IndexMetadataExceptionCode.CUSTOM_INDEX_LIMIT_REACHED:
      return 409;
    case IndexMetadataExceptionCode.INDEX_CREATION_FAILED:
      return 500;
    default:
      return assertUnreachable(code);
  }
};
