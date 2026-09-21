export interface QueueJobRetryBackoff {
  type: 'exponential' | 'fixed';
  delay: number;
  jitter?: number;
}

export interface QueueJobOptions {
  id?: string;
  allowDuplicatedPrefixes?: boolean;
  priority?: number;
  retryLimit?: number;
  retryBackoff?: QueueJobRetryBackoff;
  delay?: number;
}

export interface QueueCronJobOptions extends QueueJobOptions {
  repeat: {
    every?: number;
    pattern?: string;
    limit?: number;
  };
}
