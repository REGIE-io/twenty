import { Field, InputType } from '@nestjs/graphql';

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import { UUIDScalarType } from 'src/engine/api/graphql/workspace-schema-builder/graphql-types/scalars';
import { CreateIndexFieldInput } from 'src/engine/metadata-modules/index-metadata/dtos/create-index-field.input';
import { IndexType } from 'src/engine/metadata-modules/index-metadata/types/indexType.types';

@InputType()
export class CreateIndexInput {
  @IsUUID()
  @Field(() => UUIDScalarType)
  objectMetadataId!: string;

  // Order matters: Postgres uses the leading column first.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @Type(() => CreateIndexFieldInput)
  @ValidateNested({ each: true })
  @Field(() => [CreateIndexFieldInput])
  fields!: CreateIndexFieldInput[];

  @IsEnum(IndexType)
  @Field(() => IndexType, { defaultValue: IndexType.BTREE })
  indexType!: IndexType;

  // Index creation was originally only exposed by the settings UI, which
  // creates non-unique performance indexes. Metadata provisioners also need
  // to express datastore-enforced uniqueness (for example, an idempotency
  // key), so keep the safe default while allowing that explicit contract.
  @IsBoolean()
  @Field(() => Boolean, { defaultValue: false })
  isUnique?: boolean = false;

  // indexWhereClause is not exposed: the validator only allows a hardcoded
  // allowlist, so a free-text field on the user-facing API would mislead.
}
