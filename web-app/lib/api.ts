'use client';

import { resolveApiUrl, type ApiErrorContract, type Paginated } from '@texasrenters/shared';

import { supabase } from './supabase';

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
      headers: { authorization: `Bearer ${data.session.access_token}` },
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

export function queryString(input: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value));
  });
  const value = params.toString();
  return value ? `?${value}` : '';
}

export type Page<T> = Paginated<T>;
