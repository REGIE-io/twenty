import { ArgsType, Field, InputType, Int } from '@nestjs/graphql';

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

@InputType('PhoneSearchLookupInput')
export class PhoneSearchLookupInputDTO {
  @Field(() => String)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  clientReference: string;

  @Field(() => String)
  @IsString()
  phoneNumber: string;
}

@ArgsType()
export class SearchPeopleByPhonesArgs {
  @Field(() => [PhoneSearchLookupInputDTO])
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100, { message: 'lookups cannot exceed 100 items' })
  @ValidateNested({ each: true })
  @Type(() => PhoneSearchLookupInputDTO)
  lookups: PhoneSearchLookupInputDTO[];

  @Field(() => Int, { defaultValue: 10 })
  @IsInt()
  @Min(1)
  @Max(100, { message: 'matchLimitPerPhone cannot exceed 100 items' })
  matchLimitPerPhone: number = 10;
}
