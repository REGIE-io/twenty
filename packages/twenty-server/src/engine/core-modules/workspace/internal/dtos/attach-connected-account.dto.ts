import { Transform } from 'class-transformer';
import {
  IsBoolean,
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

  @IsString()
  @IsNotEmpty()
  regieMailboxId: string;

  @IsOptional()
  @IsIn(Object.values(CalendarChannelVisibility))
  calendarVisibility?: CalendarChannelVisibility;

  // Defaults to true in the service. Resolving a token during attach turns a
  // misconfiguration into a loud failure here rather than a silent one at sync time.
  @IsOptional()
  @IsBoolean()
  verifyTokenDelegation?: boolean;
}
