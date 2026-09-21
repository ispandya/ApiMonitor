import { z } from 'zod';

// The Redis pub/sub channel the worker publishes to and the API listens on.
export const EVENTS_CHANNEL = 'monitor-events';

export const monitorEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('check'),
    monitorId: z.uuid(),
    status: z.enum(['up', 'down']),
    status_code: z.number().nullable(),
    latency_ms: z.number().nullable(),
    error_message: z.string().nullable(),
    checked_at: z.string(),
  }),
  z.object({
    type: z.literal('incident'),
    monitorId: z.uuid(),
    incidentId: z.uuid(),
    event: z.enum(['opened', 'resolved']),
  }),
]);

export type MonitorEvent = z.infer<typeof monitorEventSchema>;
