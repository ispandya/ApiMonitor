import type { Monitor } from '../services/monitors';

export interface ProbeResult {
  status: 'up' | 'down';
  status_code: number | null;
  latency_ms: number | null;
  error_message: string | null;
}

export async function probe(
  monitor: Pick<Monitor, 'url' | 'method' | 'expected_status' | 'timeout_ms'>,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(monitor.url, {
      method: monitor.method,
      signal: AbortSignal.timeout(monitor.timeout_ms),
    });
    // Latency is time to response headers. Discard the body so a big page is not downloaded.
    const latency_ms = Math.round(performance.now() - started);
    await response.body?.cancel();

    if (response.status === monitor.expected_status) {
      return { status: 'up', status_code: response.status, latency_ms, error_message: null };
    }
    return {
      status: 'down',
      status_code: response.status,
      latency_ms,
      error_message: `expected status ${monitor.expected_status}, got ${response.status}`,
    };
  } catch (err) {
    // A probe that cannot reach the target is a normal result ("down"), not a job failure.
    return { status: 'down', status_code: null, latency_ms: null, error_message: describe(err, monitor) };
  }
}

function describe(err: unknown, monitor: Pick<Monitor, 'timeout_ms'>): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return `timed out after ${monitor.timeout_ms}ms`;
    // fetch wraps the network error; the useful code (ECONNREFUSED, ENOTFOUND) is in cause.
    const cause = err.cause as { code?: string } | undefined;
    return cause?.code ?? err.message;
  }
  return String(err);
}
