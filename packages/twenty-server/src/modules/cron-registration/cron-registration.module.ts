import { Module } from '@nestjs/common';

import { CronRegistrationService } from 'src/modules/cron-registration/cron-registration.service';

// No imports: MessageQueueModule is @Global(), so @InjectMessageQueue resolves without one.
// The cron commands this replaces do the same.
@Module({
  providers: [CronRegistrationService],
})
export class CronRegistrationModule {}
