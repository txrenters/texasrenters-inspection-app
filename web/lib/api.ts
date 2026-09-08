'use client';

import { resolveApiUrl, type ApiErrorContract, type Paginated } from '@texasrenters/shared';

import { getSession, signOut } from './session';

/**
 * Bypasses ngrok's free-tier browser interstitial.
 *
 * Without it, ngrok answers any browser-User-Agent request with an HTML warning
 * page instead of proxying to the API. That page carries no
 * `Access-Control-Allow-Origin`, so the browser reports a CORS failure and the
 * real cause — that the request never reached the backend at all — is invisible.
 * The preflight already succeeds, which makes it look like a server misconfig.
 *
 * Harmless against a non-ngrok host, and free: every request here already sends
 * `authorization`, which is not CORS-safelisted, so a preflight happens either
 * way and this adds no extra round trip.
 */
const NGROK_SKIP_INTERSTITIAL = { 'ngrok-skip-browser-warning': 'true' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The administrator API is not configured.');
  // Refreshes in place when the token is close to expiry, which is what makes
  // renewal automatic — the Supabase client did this inside its own
  // getSession() and nothing ever called refreshSession() explicitly.
  const session = await getSession();
  if (!session) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired.');
  let response: Response;
  try {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    response = await fetch(resolveApiUrl(baseUrl, path), {
      ...options,
      headers: {
        ...(isFormData ? {} : { 'content-type': 'application/json' }),
        ...NGROK_SKIP_INTERSTITIAL,
        authorization: `Bearer ${session.accessToken}`,
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check your connection.');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorContract | null;
    if (response.status === 401) await signOut();
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId ?? response.headers.get('x-request-id') ?? undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  /**
   * An empty body is `null`, not a parse error.
   *
   * A Nest handler that returns `null` — "no comparison for this move-out yet",
   * "no import running here" — serialises as a **200 with no body**, not a 204.
   * Calling `.json()` on that throws "Unexpected end of JSON input", and the
   * console renders a data-loading failure over a page that is working
   * perfectly: the answer really is nothing.
   *
   * Read as text first so the empty case is a value rather than an exception.
   */
  const body = await response.text();
  if (!body) return null as T;
  return JSON.parse(body) as T;
}

/**
 * A file upload that can say how far along it is.
 *
 * `fetch` cannot report upload progress — a request body stream is write-only
 * from the caller's side — so this is the one place that uses
 * `XMLHttpRequest`, whose `upload.onprogress` can.
 *
 * It matters because of what the numbers actually are. A report PDF is tens of
 * megabytes and a recent one spent **165 seconds** in transit; the server
 * logged the request as slow having run no queries at all, because it was
 * simply receiving bytes. Three minutes of a spinner that says "Uploading…"
 * and never moves is indistinguishable from a hang, which is what it was
 * reported as.
 *
 * This is also the only phase of an import that genuinely cannot be walked
 * away from: nothing is stored until the file lands, so it is the phase that
 * most needs to show progress and was the only one showing none.
 *
 * The error contract is deliberately the same `ApiError` the rest of the
 * client throws, including the 401 sign-out, so callers cannot tell the two
 * transports apart.
 */
export async function apiUpload<T>(
  path: string,
  body: FormData,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The administrator API is not configured.');
  const session = await getSession();
  if (!session) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired.');

  const failure = (status: number, raw: string) => {
    const error = (() => {
      try {
        return JSON.parse(raw) as ApiErrorContract;
      } catch {
        return null;
      }
    })();
    return new ApiError(
      status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId,
    );
  };

  const status = await new Promise<{ code: number; body: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', resolveApiUrl(baseUrl, path));
    // No content-type: the browser sets it with the multipart boundary, and
    // overriding it produces a body the server cannot parse.
    request.setRequestHeader('authorization', `Bearer ${session.accessToken}`);
    for (const [header, value] of Object.entries(NGROK_SKIP_INTERSTITIAL))
      request.setRequestHeader(header, value);

    if (onProgress)
      request.upload.onprogress = (event) => {
        // `lengthComputable` is false when the size is unknown; reporting 0 for
        // ever would be worse than the spinner this replaces, so it is left to
        // the caller's indeterminate state.
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };

    request.onload = () => resolve({ code: request.status, body: request.responseText });
    // Network-level failure. XHR deliberately tells the page nothing about why,
    // so neither do we — guessing would be inventing a cause.
    request.onerror = () =>
      reject(new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check your connection.'));
    request.onabort = () => reject(new ApiError(0, 'UPLOAD_CANCELLED', 'The upload was cancelled.'));

    signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(body);
  });

  if (status.code === 401) {
    await signOut();
    throw failure(401, status.body);
  }
  if (status.code < 200 || status.code >= 300) throw failure(status.code, status.body);
  // Same reasoning as `api`: an empty body is an answer, not a failure.
  if (status.code === 204 || !status.body) return null as T;
  return JSON.parse(status.body) as T;
}

export async function apiBlob(path: string, signal?: AbortSignal) {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The administrator API is not configured.');
  // Refreshes in place when the token is close to expiry, which is what makes
  // renewal automatic — the Supabase client did this inside its own
  // getSession() and nothing ever called refreshSession() explicitly.
  const session = await getSession();
  if (!session) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired.');
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(baseUrl, path), {
      signal,
      headers: {
        ...NGROK_SKIP_INTERSTITIAL,
        authorization: `Bearer ${session.accessToken}`,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check your connection.');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorContract | null;
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId,
    );
  }
  return response.blob();
}

/**
 * One request, reported in full: status, headers, timing and body, whether it
 * succeeded or not.
 *
 * `api` is the wrong shape for the API reference console. It throws on a
 * non-2xx and keeps only the code and message, but a 422's validation details
 * and a 429's rate-limit headers are precisely what an operator opened the
 * console to read — and a 404 is a legitimate, informative answer there rather
 * than a failure.
 *
 * The credential is supplied by the caller rather than taken from the session.
 * The API reference sends an integration's own API key, so what you see is what
 * that integration would get — including the 403 on a route no key may reach.
 */
export interface RawApiResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** The response as text when it was not JSON, so a non-JSON answer is still visible. */
  text?: string;
  durationMs: number;
}

export async function apiRawRequest(
  path: string,
  options: { method: string; body?: string; headers: Record<string, string>; signal?: AbortSignal },
): Promise<RawApiResponse> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The administrator API is not configured.');

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(baseUrl, path), {
      method: options.method,
      signal: options.signal,
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: {
        'content-type': 'application/json',
        ...NGROK_SKIP_INTERSTITIAL,
        // Whatever credential the caller chose. No session token is added here:
        // the API reference authenticates as the integration being documented,
        // not as the person reading the page.
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check your connection.');
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const raw = await response.text();
  let body: unknown;
  let text: string | undefined;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // A PDF, an image, or an HTML error page from something in front of the API.
    body = null;
    text = raw.slice(0, 4_000);
  }
  return { status: response.status, statusText: response.statusText, headers, body, text, durationMs };
}

/**
 * Unauthenticated write for the few endpoints reachable while signed out.
 *
 * `api` demands a session and rejects with "Your session has expired." before
 * it sends anything — which is exactly what a signed-out visitor asking to
 * reset their password does not have. Separate from `publicApi` because that
 * one is GET-only and words its failures in terms of reports.
 */
export async function publicApiSend<T>(path: string, init: RequestInit): Promise<T | undefined> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) throw new ApiError(0, 'API_NOT_CONFIGURED', 'The service is not configured.');
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(baseUrl, path), {
      ...init,
      headers: {
        'content-type': 'application/json',
        // Needed here for the same reason as `api`: without it ngrok answers
        // with its interstitial, which carries no Access-Control-Allow-Origin,
        // and the browser reports a CORS failure for a request that never
        // reached the backend.
        ...NGROK_SKIP_INTERSTITIAL,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The request could not be sent. Check your connection.');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorContract | null;
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId ?? undefined,
    );
  }
  // 204 is the normal answer here, and has no body to parse.
  return response.status === 204 ? undefined : ((await response.json()) as T);
}

/** Unauthenticated fetch for public capability-URL endpoints (homeowner reports). */
export async function publicApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The report service is not configured.');
  let response: Response;
  try {
    // Same interstitial trap: a report opened from a share link goes through
    // the same tunnel, with no authorization header to force a preflight.
    response = await fetch(resolveApiUrl(baseUrl, path), {
      headers: { ...NGROK_SKIP_INTERSTITIAL },
      signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The report could not be loaded. Check your connection.');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorContract | null;
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The report could not be loaded.',
      error?.requestId ?? undefined,
    );
  }
  return response.json() as Promise<T>;
}

export function queryString(input: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const value = params.toString();
  return value ? `?${value}` : '';
}

export type Page<T> = Paginated<T>;
