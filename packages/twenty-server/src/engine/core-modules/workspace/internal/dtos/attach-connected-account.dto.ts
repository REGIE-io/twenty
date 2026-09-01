import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import {
  CalendarChannelVisibility,
  ConnectedAccountProvider,
} from 'twenty-shared/types';

const lowercased = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// Only the providers Regie delegates. The rest are self-hosted or app connections that
// never route through this endpoint.
const DELEGATABLE_PROVIDERS = [
  ConnectedAccountProvider.GOOGLE,
  ConnectedAccountProvider.MICROSOFT,
];

export class AttachConnectedAccountDto {
  @IsIn(DELEGATABLE_PROVIDERS)
  provider: ConnectedAccountProvider;

  @Transform(lowercased)
  @IsEmail()
  handle: string;

  @Transform(lowercased)
  @IsEmail()
  memberEmail: string;

  // Regie owns the OAuth grant; Twenty stores these and refreshes them itself. Required,
  // because an account saved without them cannot sync and fails only at the next cron.
  @IsString()
  @IsNotEmpty()
  accessToken: string;

  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @IsOptional()
  @IsIn(Object.values(CalendarChannelVisibility))
  calendarVisibility?: CalendarChannelVisibility;
}
