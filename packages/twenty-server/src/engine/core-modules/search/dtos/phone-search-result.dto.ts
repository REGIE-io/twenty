import { Field, ObjectType } from '@nestjs/graphql';
import { UUIDScalarType } from 'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars';

@ObjectType('PhoneSearchRecord')
export class PhoneSearchRecordDTO {
  @Field(() => UUIDScalarType)
  recordId: string;
}

@ObjectType('PhoneSearchResultEdge')
export class PhoneSearchResultEdgeDTO {
  @Field(() => PhoneSearchRecordDTO)
  node: PhoneSearchRecordDTO;

  @Field(() => String)
  cursor: string;
}

@ObjectType('PhoneSearchResultPageInfo')
export class PhoneSearchResultPageInfoDTO {
  @Field(() => String, { nullable: true })
  endCursor: string | null;

  @Field(() => Boolean)
  hasNextPage: boolean;
}

@ObjectType('PhoneSearchResultConnection')
export class PhoneSearchResultConnectionDTO {
  @Field(() => [PhoneSearchResultEdgeDTO])
  edges: PhoneSearchResultEdgeDTO[];

  @Field(() => PhoneSearchResultPageInfoDTO)
  pageInfo: PhoneSearchResultPageInfoDTO;
}
