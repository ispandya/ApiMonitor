export class WebhookError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

// POSTs a JSON payload. Resolves on any 2xx; throws WebhookError otherwise, marking whether
// trying again could plausibly help.
export async function deliverWebhook(
  url: string,
  payload: unknown,
  idempotencyKey: string,
  timeoutMs = 10_000,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'api-monitor',
        // Delivery is at-least-once, so receivers can use this to ignore repeats.
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      // Do not follow redirects: a webhook that redirects is misconfigured, and following
      // them could send our request somewhere the customer never chose.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Could not reach the receiver at all (timeout, refused, DNS): worth retrying.
    throw new WebhookError(describe(err, timeoutMs), true);
  }
  await response.body?.cancel();

  if (response.status >= 200 && response.status < 300) return;

  // 5xx, 408 (timeout) and 429 (rate limited) are usually temporary. Other 4xx and 3xx mean
  // the request itself is wrong, and sending it again will not change the answer.
  const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
  throw new WebhookError(`webhook responded ${response.status}`, retryable);
}

function describe(err: unknown, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `timed out after ${timeoutMs}ms`;
    const cause = err.cause as { code?: string } | undefined;
    return cause?.code ?? err.message;
  }
  return String(err);
}
