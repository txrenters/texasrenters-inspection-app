import { NextResponse } from 'next/server';

import { apiBaseUrl } from '@/lib/session-cookies';

/**
 * GET /api/session/portal — whether to offer "Sign in with TR Staff Portal".
 *
 * Asked from this app's own server so the login page needs no API address of
 * its own. Anything but a clear yes is a no: an API that cannot be reached
 * leaves the login page exactly as it was before the portal existed.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  let enabled = false;
  try {
    const upstream = await fetch(`${apiBaseUrl()}/api/v1/auth/portal`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      cache: 'no-store',
    });
    if (upstream.ok) enabled = ((await upstream.json()) as { enabled?: unknown }).enabled === true;
  } catch {
    enabled = false;
  }
  return NextResponse.json({ enabled }, { headers: { 'cache-control': 'no-store' } });
}
