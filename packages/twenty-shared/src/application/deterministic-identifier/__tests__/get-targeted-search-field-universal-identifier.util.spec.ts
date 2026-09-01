import { getSearchFieldUniversalIdentifier } from '@/application/deterministic-identifier/get-search-field-universal-identifier.util';
import { getTargetedSearchFieldUniversalIdentifier } from '@/application/deterministic-identifier/get-targeted-search-field-universal-identifier.util';

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_FIELD_ID = '33333333-3333-4333-8333-333333333333';
const GENERIC_VECTOR_ID = '20202020-3333-4333-8333-333333333333';
const PHONE_VECTOR_ID = '20202020-4444-4444-8444-444444444444';

describe('getTargetedSearchFieldUniversalIdentifier', () => {
  it('is stable for the same source/target pair and distinct across targets', () => {
    const args = {
      applicationUniversalIdentifier: APPLICATION_ID,
      fieldMetadataUniversalIdentifier: SOURCE_FIELD_ID,
    };
    const genericTarget = getTargetedSearchFieldUniversalIdentifier({
      ...args,
      tsVectorFieldMetadataUniversalIdentifier: GENERIC_VECTOR_ID,
    });
    const phoneTarget = getTargetedSearchFieldUniversalIdentifier({
      ...args,
      tsVectorFieldMetadataUniversalIdentifier: PHONE_VECTOR_ID,
    });

    expect(
      getTargetedSearchFieldUniversalIdentifier({
        ...args,
        tsVectorFieldMetadataUniversalIdentifier: PHONE_VECTOR_ID,
      }),
    ).toBe(phoneTarget);
    expect(genericTarget).not.toBe(phoneTarget);
  });

  it('does not change the legacy generic identifier', () => {
    expect(
      getSearchFieldUniversalIdentifier({
        applicationUniversalIdentifier: APPLICATION_ID,
        fieldMetadataUniversalIdentifier: SOURCE_FIELD_ID,
      }),
    ).toBe('db4e5b93-15b6-5c83-a0b3-6c031e0ca072');
  });
});
