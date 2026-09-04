import { MessageParticipantRole } from 'twenty-shared/types';

import { MessageDirection } from 'src/modules/messaging/common/enums/message-direction.enum';
import { type MessageWithParticipants } from 'src/modules/messaging/message-import-manager/types/message';
import { isBounce } from 'src/modules/messaging/message-import-manager/utils/is-bounce.util';

const buildMessage = (
  overrides: Partial<MessageWithParticipants>,
): MessageWithParticipants =>
  ({
    externalId: 'external-id',
    headerMessageId: 'header-id',
    subject: 'Delivery Status Notification (Failure)',
    messageThreadExternalId: 'thread-id',
    receivedAt: new Date('2026-09-04T00:00:00.000Z'),
    direction: MessageDirection.INCOMING,
    text: 'Address not found',
    attachments: [],
    participants: [
      {
        role: MessageParticipantRole.FROM,
        handle: 'sender@example.com',
        displayName: 'Sender',
      },
      {
        role: MessageParticipantRole.TO,
        handle: 'rep@regie.ai',
        displayName: 'Rep',
      },
    ],
    messageHeaders: [],
    ...overrides,
  }) as MessageWithParticipants;

describe('isBounce', () => {
  it('detects the RFC 3464 delivery-status report envelope', () => {
    const message = buildMessage({
      messageHeaders: [
        {
          name: 'Content-Type',
          value: 'multipart/report; report-type=delivery-status; boundary=x',
        },
      ],
    });

    expect(isBounce(message)).toBe(true);
  });

  it('detects the quoted report-type form', () => {
    const message = buildMessage({
      messageHeaders: [
        {
          name: 'content-type',
          value: 'multipart/report; report-type="delivery-status"',
        },
      ],
    });

    expect(isBounce(message)).toBe(true);
  });

  it('detects the X-Failed-Recipients header', () => {
    const message = buildMessage({
      messageHeaders: [
        { name: 'X-Failed-Recipients', value: 'zhao@notion.com' },
      ],
    });

    expect(isBounce(message)).toBe(true);
  });

  it('detects a mailer-daemon sender when report headers are absent', () => {
    const message = buildMessage({
      participants: [
        {
          role: MessageParticipantRole.FROM,
          handle: 'MAILER-DAEMON@googlemail.com',
          displayName: 'Mail Delivery Subsystem',
        },
        {
          role: MessageParticipantRole.TO,
          handle: 'rep@regie.ai',
          displayName: 'Rep',
        },
      ],
    });

    expect(isBounce(message)).toBe(true);
  });

  it('detects a postmaster sender', () => {
    const message = buildMessage({
      participants: [
        {
          role: MessageParticipantRole.FROM,
          handle: 'postmaster@outlook.com',
          displayName: 'Postmaster',
        },
      ],
    });

    expect(isBounce(message)).toBe(true);
  });

  it('does not flag an ordinary newsletter as a bounce', () => {
    const message = buildMessage({
      subject: 'Weekly digest',
      participants: [
        {
          role: MessageParticipantRole.FROM,
          handle: 'news@substack.com',
          displayName: 'Newsletter',
        },
      ],
      messageHeaders: [
        { name: 'List-Unsubscribe', value: '<https://unsub.example>' },
        { name: 'Content-Type', value: 'text/html; charset=UTF-8' },
      ],
    });

    expect(isBounce(message)).toBe(false);
  });
});
