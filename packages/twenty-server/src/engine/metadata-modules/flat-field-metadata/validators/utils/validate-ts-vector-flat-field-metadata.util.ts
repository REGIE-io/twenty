import { msg } from '@lingui/core/macro';
import { type FieldMetadataType } from 'twenty-shared/types';

import { FieldMetadataExceptionCode } from 'src/engine/metadata-modules/field-metadata/field-metadata.exception';
import { PHONE_SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/phone-search-vector-field.constants';
import { SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/search-field-metadata/constants/search-vector-field.constants';
import { type FlatFieldMetadataTypeValidationArgs } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata-type-validator.type';
import { type FlatFieldMetadataValidationError } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata-validation-error.type';

export const validateTsVectorFlatFieldMetadata = ({
  flatEntityToValidate,
}: FlatFieldMetadataTypeValidationArgs<FieldMetadataType.TS_VECTOR>): FlatFieldMetadataValidationError[] => {
  const errors: FlatFieldMetadataValidationError[] = [];

  if (
    flatEntityToValidate.name !== SEARCH_VECTOR_FIELD.name &&
    flatEntityToValidate.name !== PHONE_SEARCH_VECTOR_FIELD.name
  ) {
    errors.push({
      code: FieldMetadataExceptionCode.INVALID_FIELD_INPUT,
      message: `Field type TS_VECTOR must be named "${SEARCH_VECTOR_FIELD.name}" or "${PHONE_SEARCH_VECTOR_FIELD.name}", got "${flatEntityToValidate.name}"`,
      value: flatEntityToValidate.name,
      userFriendlyMessage: msg`Field type TS_VECTOR must use a reserved system name`,
    });
  }

  if (!flatEntityToValidate.isSystem) {
    errors.push({
      code: FieldMetadataExceptionCode.INVALID_FIELD_INPUT,
      message: 'Field type TS_VECTOR must be a system field',
      value: flatEntityToValidate.isSystem,
      userFriendlyMessage: msg`Field type TS_VECTOR must be a system field`,
    });
  }

  return errors;
};
