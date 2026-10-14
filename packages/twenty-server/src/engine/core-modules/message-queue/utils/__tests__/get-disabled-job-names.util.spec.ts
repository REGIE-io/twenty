import { getDisabledJobNames } from 'src/engine/core-modules/message-queue/utils/get-disabled-job-names.util';
import { type TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';

const configWith = (disabledJobs: string[]) =>
  ({
    get: (key: string) => (key === 'DISABLED_JOBS' ? disabledJobs : undefined),
  }) as unknown as TwentyConfigService;

describe('getDisabledJobNames', () => {
  it('returns the listed job names, trimmed', () => {
    expect(
      getDisabledJobNames(
        configWith([' CallWebhookJobsJob', 'GenerateSdkClientJob ']),
      ),
    ).toEqual(new Set(['CallWebhookJobsJob', 'GenerateSdkClientJob']));
  });

  it('treats an empty env value as nothing disabled', () => {
    expect(getDisabledJobNames(configWith(['']))).toEqual(new Set());
    expect(getDisabledJobNames(configWith([]))).toEqual(new Set());
  });
});
