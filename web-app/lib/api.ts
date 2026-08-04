'use client';

import { resolveApiUrl, type ApiErrorContract, type Paginated } from '@texasrenters/shared';

import { supabase } from './supabase';

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
  const { data } = await supabase().auth.getSession();
  if (!data.session) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired.');
  let response: Response;
  try {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    response = await fetch(resolveApiUrl(baseUrl, path), {
      ...options,
      headers: {
        ...(isFormData ? {} : { 'content-type': 'application/json' }),
        ...NGROK_SKIP_INTERSTITIAL,
        authorization: `Bearer ${data.session.access_token}`,
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached. Check your connection.');
  }
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as ApiErrorContract | null;
    if (response.status === 401) await supabase().auth.signOut({ scope: 'local' });
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId ?? response.headers.get('x-request-id') ?? undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function apiBlob(path: string, signal?: AbortSignal) {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl)
    throw new ApiError(0, 'API_NOT_CONFIGURED', 'The administrator API is not configured.');
  const { data } = await supabase().auth.getSession();
  if (!data.session) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired.');
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(baseUrl, path), {
      signal,
      headers: {
        ...NGROK_SKIP_INTERSTITIAL,
        authorization: `Bearer ${data.session.access_token}`,
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
