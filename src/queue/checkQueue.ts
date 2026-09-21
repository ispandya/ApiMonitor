import { Queue } from 'bullmq';
import { CHECK_QUEUE_NAME, type CheckJobData } from './checkJob';
import { redisConnection } from './connection';

export const checkQueue = new Queue<CheckJobData>(CHECK_QUEUE_NAME, {
  connection: redisConnection,
});
