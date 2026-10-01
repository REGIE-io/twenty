import { randomUUID } from 'node:crypto';
import { DataSource, EntitySchema } from 'typeorm';
import { TimelineMessagingService } from '../timeline-messaging.service';

const url = process.env.CRM_DUPLICATES_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
type TestPerson = {
  id: string;
  emailsPrimaryEmail: string | null;
  emailsAdditionalEmails: string[] | null;
  deletedAt: Date | null;
};
type TestThread = { id: string; messages: TestMessage[] };
type TestMessage = {
  id: string;
  messageThreadId: string;
  receivedAt: Date;
  subject: string;
  text: string;
  isDraft: boolean;
  messageThread: TestThread;
  messageParticipants: TestParticipant[];
  messageChannelMessageAssociations: TestAssociation[];
};
type TestParticipant = {
  id: string;
  messageId: string;
  personId: string | null;
  handle: string;
  message: TestMessage;
};
type TestAssociation = { id: string; messageId: string; message: TestMessage };
const id = { type: 'uuid' as const, primary: true };
const person = new EntitySchema<TestPerson>({
  name: 'TestPerson',
  tableName: 'person',
  columns: {
    id,
    emailsPrimaryEmail: { type: 'text', nullable: true },
    emailsAdditionalEmails: { type: 'jsonb', nullable: true },
    deletedAt: { type: 'timestamptz', nullable: true, deleteDate: true },
  },
});
const thread = new EntitySchema<TestThread>({
  name: 'TestThread',
  tableName: 'messageThread',
  columns: { id },
  relations: {
    messages: {
      type: 'one-to-many',
      target: 'TestMessage',
      inverseSide: 'messageThread',
    },
  },
});
const message = new EntitySchema<TestMessage>({
  name: 'TestMessage',
  tableName: 'message',
  columns: {
    id,
    messageThreadId: { type: 'uuid' },
    receivedAt: { type: 'timestamptz' },
    subject: { type: 'text' },
    text: { type: 'text' },
    isDraft: { type: 'boolean', default: false },
  },
  relations: {
    messageThread: {
      type: 'many-to-one',
      target: 'TestThread',
      joinColumn: { name: 'messageThreadId' },
    },
    messageParticipants: {
      type: 'one-to-many',
      target: 'TestParticipant',
      inverseSide: 'message',
    },
    messageChannelMessageAssociations: {
      type: 'one-to-many',
      target: 'TestAssociation',
      inverseSide: 'message',
    },
  },
});
const participant = new EntitySchema<TestParticipant>({
  name: 'TestParticipant',
  tableName: 'messageParticipant',
  columns: {
    id,
    messageId: { type: 'uuid' },
    personId: { type: 'uuid', nullable: true },
    handle: { type: 'text' },
  },
  relations: {
    message: {
      type: 'many-to-one',
      target: 'TestMessage',
      joinColumn: { name: 'messageId' },
    },
  },
});
const association = new EntitySchema<TestAssociation>({
  name: 'TestAssociation',
  tableName: 'messageChannelMessageAssociation',
  columns: { id, messageId: { type: 'uuid' } },
  relations: {
    message: {
      type: 'many-to-one',
      target: 'TestMessage',
      joinColumn: { name: 'messageId' },
    },
  },
});

integration('shared-address history SQL', () => {
  const schema = `duplicates_${randomUUID().replace(/-/g, '')}`;
  const workspaceId = randomUUID();
  const personA = randomUUID();
  const personB = randomUUID();
  let database: DataSource;
  let service: TimelineMessagingService;
  const threads: Record<string, string> = {};

  beforeAll(async () => {
    jest.useRealTimers();
    database = new DataSource({
      type: 'postgres',
      url,
      schema,
      entities: [person, thread, message, participant, association],
    });
    await database.initialize();
    await database.query(`CREATE SCHEMA "${schema}"`);
    await database.synchronize();
    await database.getRepository(person).insert([
      {
        id: personA,
        emailsPrimaryEmail: 'Shared@Example.test',
        emailsAdditionalEmails: ['Alias@example.test'],
      },
      {
        id: personB,
        emailsPrimaryEmail: 'shared@example.test',
        emailsAdditionalEmails: [],
      },
    ]);
    const records = [
      {
        name: 'shared',
        handle: ' SHARED@example.test ',
        personId: null,
        mailbox: true,
      },
      {
        name: 'alias',
        handle: 'ALIAS@example.test',
        personId: null,
        mailbox: true,
      },
      {
        name: 'explicit',
        handle: 'shared@example.test',
        personId: personA,
        mailbox: false,
      },
      {
        name: 'unrelated',
        handle: 'other@example.test',
        personId: null,
        mailbox: true,
      },
    ];
    for (const record of records) {
      const threadId = randomUUID();
      const messageId = randomUUID();
      threads[record.name] = threadId;
      await database.getRepository(thread).insert({ id: threadId });
      await database.getRepository(message).insert({
        id: messageId,
        messageThreadId: threadId,
        receivedAt: new Date(),
        subject: record.name,
        text: record.name,
      });
      await database.getRepository(participant).insert({
        id: randomUUID(),
        messageId,
        personId: record.personId,
        handle: record.handle,
      });
      if (record.mailbox)
        await database
          .getRepository(association)
          .insert({ id: randomUUID(), messageId });
      if (record.name === 'shared')
        await database.getRepository(participant).insert({
          id: randomUUID(),
          messageId,
          personId: null,
          handle: 'shared@example.test',
        });
    }
    const repositories: Record<string, EntitySchema> = {
      person,
      messageThread: thread,
    };
    const manager = {
      executeInWorkspaceContext: async (callback: () => Promise<unknown>) =>
        callback(),
      getRepository: async (requestedWorkspace: string, name: string) => {
        expect(requestedWorkspace).toBe(workspaceId);
        return database.getRepository(repositories[name]);
      },
    };
    service = new TimelineMessagingService(
      manager as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    if (database?.isInitialized) {
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.destroy();
    }
  });

  it('shares exact primary addresses without sharing a direct CRM activity or the whole domain', async () => {
    const result = await service.getAndCountMessageThreads(
      [personB],
      workspaceId,
      0,
      20,
    );
    expect(result.messageThreads.map((item) => item.id)).toEqual([
      threads.shared,
    ]);
    expect(result.totalNumberOfThreads).toBe(1);
  });

  it('includes additional addresses and explicit links, deduplicating threads across people and participants', async () => {
    const result = await service.getAndCountMessageThreads(
      [personA, personB],
      workspaceId,
      0,
      20,
    );
    expect(result.messageThreads.map((item) => item.id).sort()).toEqual(
      [threads.shared, threads.alias, threads.explicit].sort(),
    );
    expect(result.totalNumberOfThreads).toBe(3);
    const page = await service.getAndCountMessageThreads(
      [personA, personB],
      workspaceId,
      0,
      1,
    );
    expect(page.messageThreads).toHaveLength(1);
    expect(page.totalNumberOfThreads).toBe(3);
  });
});
