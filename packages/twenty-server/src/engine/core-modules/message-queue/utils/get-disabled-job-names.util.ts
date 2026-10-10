import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

export const getDisabledJobNames = (
  twentyConfigService: TwentyConfigService,
): ReadonlySet<string> =>
  new Set(
    twentyConfigService
      .get('DISABLED_JOBS')
      .map((jobName) => jobName.trim())
      .filter((jobName) => jobName.length > 0),
  );
