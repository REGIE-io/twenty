import nodeFetch from 'node-fetch';
import { type JestConfigWithTsJest } from 'ts-jest';
import 'tsconfig-paths/register';

import { rawDataSource } from 'src/database/typeorm/raw/raw.datasource';
import {
  SEED_APPLE_WORKSPACE_ID,
  SEED_YCOMBINATOR_WORKSPACE_ID,
} from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

import { assertChatParticipantSchema } from './assert-chat-participant-schema.util';
import { createApp } from './create-app';
import { createWorkflowTestServices } from './create-workflow-test-services';
import { waitForTestDatabaseReset } from './wait-for-test-database-reset.util';

export default async (_: unknown, projectConfig: JestConfigWithTsJest) => {
  // node-fetch rides node:http, which msw patches; native undici fetch
  // escapes interception.
  globalThis.fetch = nodeFetch as unknown as typeof globalThis.fetch;

  await waitForTestDatabaseReset();

  if (!projectConfig.globals) {
    throw new Error('No globals found in project config');
  }

  await rawDataSource.initialize();

  try {
    for (const workspaceId of [
      SEED_APPLE_WORKSPACE_ID,
      SEED_YCOMBINATOR_WORKSPACE_ID,
    ]) {
      await assertChatParticipantSchema(rawDataSource, workspaceId);
    }
  } catch (error) {
    await rawDataSource.destroy();
    throw error;
  }

  const app = await createApp({});

  await app.listen(projectConfig.globals.APP_PORT as number);

  global.app = app;
  global.workflowTestServices = createWorkflowTestServices(app);
  global.testDataSource = rawDataSource;
};
