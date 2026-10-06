import {
  MessageChannelVisibility,
  MessageParticipantRole,
} from 'twenty-shared/types';
import { FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED } from 'twenty-shared/constants';
import { formatThreads } from '../format-threads.util';
import { type MessageParticipantWorkspaceEntity } from 'src/modules/messaging/common/standard-objects/message-participant.workspace-entity';

const thread = {
  id: 'thread',
  subject: 'Private subject',
  lastMessageBody: 'Private body',
  lastMessageReceivedAt: new Date(),
  numberOfMessagesInThread: 1,
  lastMessageIsDraft: false,
};
const participants = {
  thread: [
    {
      id: 'participant',
      handle: 'shared@example.test',
      displayName: 'Sender',
      role: MessageParticipantRole.FROM,
      personId: null,
      workspaceMemberId: null,
    },
  ] as MessageParticipantWorkspaceEntity[],
};

test.each([
  MessageChannelVisibility.METADATA,
  MessageChannelVisibility.SUBJECT,
  undefined,
])(
  'shared-address history cannot expose message bodies with visibility %s',
  (visibility) => {
    const result = formatThreads(
      [thread],
      participants,
      visibility ? { thread: visibility } : {},
    );
    expect(result[0].lastMessageBody).toBe(
      FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
    );
    expect(result[0].subject).toBe(
      visibility === MessageChannelVisibility.SUBJECT
        ? 'Private subject'
        : FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
    );
  },
);

test('authorized shared-address history retains the message content', () => {
  const result = formatThreads([thread], participants, {
    thread: MessageChannelVisibility.SHARE_EVERYTHING,
  });
  expect(result).toHaveLength(1);
  expect(result[0].lastMessageBody).toBe('Private body');
});
