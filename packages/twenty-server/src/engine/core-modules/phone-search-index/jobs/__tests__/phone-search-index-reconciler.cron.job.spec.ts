import { PhoneSearchIndexReconcilerCronJob } from 'src/engine/core-modules/phone-search-index/jobs/phone-search-index-reconciler.cron.job';

describe('PhoneSearchIndexReconcilerCronJob', () => {
  it('invokes durable reconciliation from the registered cron processor', async () => {
    const reconciler = { reconcile: jest.fn().mockResolvedValue(0) };
    await new PhoneSearchIndexReconcilerCronJob(reconciler as never).handle();
    expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
  });
});
