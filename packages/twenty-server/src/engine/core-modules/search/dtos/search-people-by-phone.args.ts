import { ArgsType, Field, Int } from '@nestjs/graphql';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

@ArgsType()
export class SearchPeopleByPhoneArgs {
  @Field(() => String)
  @IsString()
  phoneNumber: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(100, { message: 'Limit cannot exceed 100 items' })
  limit: number;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  after?: string;
}
