import { personEmailAddresses } from '../person-email-addresses.util';

describe('personEmailAddresses', () => {
  it('normalizes exact primary and additional addresses without collapsing distinct mailboxes', () => {
    expect(
      personEmailAddresses([
        {
          emails: {
            primaryEmail: ' Shared@Example.com ',
            additionalEmails: ['Alias@example.com', ''],
          },
        },
        {
          emails: {
            primaryEmail: 'shared@example.com',
            additionalEmails: ['other@example.com'],
          },
        },
      ]),
    ).toEqual(['shared@example.com', 'alias@example.com', 'other@example.com']);
  });
  it('ignores empty addresses', () => {
    expect(
      personEmailAddresses([
        { emails: { primaryEmail: '', additionalEmails: [] } },
      ]),
    ).toEqual([]);
  });
});
