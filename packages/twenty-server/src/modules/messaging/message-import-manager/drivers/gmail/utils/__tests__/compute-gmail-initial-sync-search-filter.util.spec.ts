import { computeGmailInitialSyncSearchFilter } from 'src/modules/messaging/message-import-manager/drivers/gmail/utils/compute-gmail-initial-sync-search-filter.util';

const NOW = new Date('2026-09-04T12:00:00.000Z');
// 2026-08-05T12:00:00.000Z
const EXPECTED_CUTOFF_IN_SECONDS = 1785931200;

describe('computeGmailInitialSyncSearchFilter', () => {
  it('bounds the query to the last 30 days', () => {
    expect(computeGmailInitialSyncSearchFilter('', NOW)).toBe(
      `after:${EXPECTED_CUTOFF_IN_SECONDS}`,
    );
  });

  it('keeps the label exclusions alongside the date bound', () => {
    expect(computeGmailInitialSyncSearchFilter('-label:spam', NOW)).toBe(
      `-label:spam after:${EXPECTED_CUTOFF_IN_SECONDS}`,
    );
  });
});
