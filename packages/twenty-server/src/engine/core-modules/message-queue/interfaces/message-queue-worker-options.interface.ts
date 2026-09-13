export interface MessageQueueWorkerOptions {
  concurrency?: number;
  lockDuration?: number;
  lockRenewTime?: number;
  maxStalledCount?: number;
  boundedShutdownDrain?: boolean;
}
