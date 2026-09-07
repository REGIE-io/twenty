import { buildMicrosoftInitialSyncFilter } from 'src/modules/messaging/message-import-manager/drivers/microsoft/utils/build-microsoft-initial-sync-filter.util';

const NOW = new Date('2026-09-04T12:00:00.000Z');

describe('buildMicrosoftInitialSyncFilter', () => {
  // Graph rejects a quoted value and a fractional-seconds value on a delta $filter.
  it('bounds the delta to the last 30 days with an encoded, unquoted timestamp', () => {
    expect(buildMicrosoftInitialSyncFilter(NOW)).toBe(
      '$filter=receivedDateTime%20ge%202026-08-05T12:00:00Z',
    );
  });
});
