export interface MessageQueueWorkerOptions {
  concurrency?: number;
  globalConcurrency?: number;
  lockDuration?: number;
  lockRenewTime?: number;
  maxStalledCount?: number;
  boundedShutdownDrain?: boolean;
}
