import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

import { PhoneSearchRecordDTO } from 'src/engine/core-modules/search/dtos/phone-search-result.dto';

export enum PhoneSearchLookupStatus {
  FOUND = 'FOUND',
  NOT_FOUND = 'NOT_FOUND',
  INVALID = 'INVALID',
}

registerEnumType(PhoneSearchLookupStatus, {
  name: 'PhoneSearchLookupStatus',
});

@ObjectType('PhoneSearchLookupError')
export class PhoneSearchLookupErrorDTO {
  @Field(() => String)
  code: string;

  @Field(() => String)
  message: string;
}

@ObjectType('PhoneSearchLookupResult')
export class PhoneSearchLookupResultDTO {
  @Field(() => String)
  clientReference: string;

  @Field(() => String)
  phoneNumber: string;

  @Field(() => PhoneSearchLookupStatus)
  status: PhoneSearchLookupStatus;

  @Field(() => [PhoneSearchRecordDTO])
  matches: PhoneSearchRecordDTO[];

  @Field(() => Boolean)
  hasMore: boolean;

  @Field(() => PhoneSearchLookupErrorDTO, { nullable: true })
  error: PhoneSearchLookupErrorDTO | null;
}

@ObjectType('BulkPhoneSearchResult')
export class BulkPhoneSearchResultDTO {
  @Field(() => [PhoneSearchLookupResultDTO])
  results: PhoneSearchLookupResultDTO[];
}
