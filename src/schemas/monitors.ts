import { z } from 'zod';

export const monitorIdSchema = z.uuid();

const httpUrl = z.url({ protocol: /^https?$/ });

// Field rules shared by create and update. No defaults here: a missing field means
// "use the default" when creating but "leave it alone" when updating.
const fields = {
  name: z.string().trim().min(1).max(100),
  url: httpUrl,
  method: z.enum(['GET', 'HEAD', 'POST']),
  expected_status: z.int().min(100).max(599),
  interval_seconds: z.int().min(10).max(86400),
  timeout_ms: z.int().min(1000).max(60000),
};

export const createMonitorSchema = z.object({
  name: fields.name,
  url: fields.url,
  method: fields.method.default('GET'),
  expected_status: fields.expected_status.default(200),
  interval_seconds: fields.interval_seconds.default(60),
  timeout_ms: fields.timeout_ms.default(10000),
  webhook_url: httpUrl.optional(),
}).refine((m) => m.timeout_ms < m.interval_seconds * 1000, {
  message: 'timeout_ms must be less than the interval',
  path: ['timeout_ms'],
});

export const updateMonitorSchema = z.object(fields).partial().extend({
  webhook_url: httpUrl.nullable().optional(),
  is_active: z.boolean().optional(),
}).refine((m) => Object.keys(m).length > 0, {
  message: 'Provide at least one field to update',
});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;

// ?limit=N on the check history endpoint. Capped so one request cannot ask for the world.
export const checksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
