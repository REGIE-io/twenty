import { IndexMetadataExceptionCode } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';
import { indexMetadataExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/index-metadata/utils/index-metadata-exception-code-to-http-status.util';

describe('indexMetadataExceptionCodeToHttpStatus', () => {
  it.each([
    [IndexMetadataExceptionCode.INDEX_OBJECT_NOT_FOUND, 404],
    [IndexMetadataExceptionCode.INDEX_NOT_FOUND, 404],
    [IndexMetadataExceptionCode.INDEX_FIELDS_REQUIRED, 400],
    [IndexMetadataExceptionCode.DUPLICATE_INDEX_FIELDS, 400],
    [IndexMetadataExceptionCode.INDEX_FIELD_NOT_FOUND_ON_OBJECT, 400],
    [IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_COMPOSITE_FIELD, 400],
    [
      IndexMetadataExceptionCode.INDEX_NOT_SUPPORTED_FOR_MORH_RELATION_FIELD_AND_RELATION_FIELD,
      400,
    ],
    [IndexMetadataExceptionCode.INDEX_TYPE_NOT_SUPPORTED_FOR_FIELD_TYPE, 400],
    [IndexMetadataExceptionCode.DUPLICATE_UNIQUE_INDEX, 400],
    [IndexMetadataExceptionCode.CANNOT_DELETE_SYSTEM_INDEX, 403],
    [IndexMetadataExceptionCode.CUSTOM_INDEX_LIMIT_REACHED, 409],
    [IndexMetadataExceptionCode.INDEX_CREATION_FAILED, 500],
  ])('maps %s to %i', (code, status) => {
    expect(indexMetadataExceptionCodeToHttpStatus(code)).toBe(status);
  });

  it('keeps every client mistake below 500 so Sentry skips it', () => {
    const serverFailureCodes = Object.values(IndexMetadataExceptionCode).filter(
      (code) => indexMetadataExceptionCodeToHttpStatus(code) >= 500,
    );

    expect(serverFailureCodes).toEqual([
      IndexMetadataExceptionCode.INDEX_CREATION_FAILED,
    ]);
  });
});
