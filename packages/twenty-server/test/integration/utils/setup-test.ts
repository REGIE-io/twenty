import nodeFetch from 'node-fetch';
import { type JestConfigWithTsJest } from 'ts-jest';
import 'tsconfig-paths/register';

import { rawDataSource } from 'src/database/typeorm/raw/raw.datasource';

import { assertForcedFeatureFlagsAreEnabled } from './assert-forced-feature-flags-are-enabled.util';
import { createApp } from './create-app';
import {
  closeQueueConnections,
  discardJobsLeftByPreviousRun,
} from './wait-for-all-jobs-to-finish.util';

export default async (_: unknown, projectConfig: JestConfigWithTsJest) => {
  // node-fetch rides node:http, which msw patches; native undici fetch
  // escapes interception.
  globalThis.fetch = nodeFetch as unknown as typeof globalThis.fetch;

  // Before the app starts its workers, so none of them picks up a leftover job.
  await discardJobsLeftByPreviousRun();
  await closeQueueConnections();

  const app = await createApp({});

  if (!projectConfig.globals) {
    throw new Error('No globals found in project config');
  }

  await rawDataSource.initialize();

  await assertForcedFeatureFlagsAreEnabled(rawDataSource);

  await app.listen(projectConfig.globals.APP_PORT as number);

  global.app = app;
  global.testDataSource = rawDataSource;
};
