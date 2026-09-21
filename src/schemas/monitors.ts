import { z } from 'zod';

export const monitorIdSchema = z.uuid();

const httpUrl = z.url({ protocol: /^https?$/ });

export const createMonitorSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: httpUrl,
  method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
  expected_status: z.int().min(100).max(599).default(200),
  interval_seconds: z.int().min(10).max(86400).default(60),
  timeout_ms: z.int().min(1000).max(60000).default(10000),
  webhook_url: httpUrl.optional(),
}).refine((m) => m.timeout_ms < m.interval_seconds * 1000, {
  message: 'timeout_ms must be less than the interval',
  path: ['timeout_ms'],
});

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
