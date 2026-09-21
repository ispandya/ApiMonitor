// No imports and no side effects: safe to import from anywhere, including code that
// must not open a Redis connection just to learn a queue name.
export const CHECK_QUEUE_NAME = 'monitor-checks';

export interface CheckJobData {
  monitorId: string;
}
