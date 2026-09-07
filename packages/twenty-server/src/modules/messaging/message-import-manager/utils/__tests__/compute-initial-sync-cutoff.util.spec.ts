import { computeInitialSyncCutoff } from 'src/modules/messaging/message-import-manager/utils/compute-initial-sync-cutoff.util';

describe('computeInitialSyncCutoff', () => {
  it('reaches back 30 days', () => {
    expect(
      computeInitialSyncCutoff(new Date('2026-09-04T12:00:00.000Z')),
    ).toEqual(new Date('2026-08-05T12:00:00.000Z'));
  });
});
