/**
 * How long a request that does minutes of work may go without sending a byte.
 *
 * The server drops a connection that is idle for `HTTP_REQUEST_TIMEOUT_MS`,
 * 30 seconds by default (`main.ts`). The proxy then answers 502 with no CORS
 * headers, so the console reports a CORS failure while the work carries on out
 * of sight. Building a quarter's plan paces thousands of Google drive times and
 * took 244 seconds for Q4 2026 (2026-09-16); publishing one creates a few
 * hundred inspections a stop at a time.
 */
export const LONG_REQUEST_TIMEOUT_MS = 20 * 60_000;

/**
 * Let this one request run past the server's idle timeout.
 *
 * Replaces the timeout on the request's own connection only; every other
 * request keeps the server's. Optional so a handler called directly, as in a
 * test, needs no socket.
 */
export function holdRequestOpen(
  request: { setTimeout?: (milliseconds: number) => unknown },
  timeoutMs: number = LONG_REQUEST_TIMEOUT_MS,
) {
  request.setTimeout?.(timeoutMs);
}
