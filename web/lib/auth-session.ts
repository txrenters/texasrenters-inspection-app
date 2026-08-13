import type { AppSession } from './session';

/**
 * `must_change_password` now arrives as a claim the backend mints from its own
 * `AuthCredential.mustChangePassword` column, rather than from Supabase's
 * `app_metadata`. The column is the source of truth; the claim is the transport.
 *
 * That also settles a disagreement between the two clients: the web app read
 * this from the JWT while mobile read it from `/auth/me`, so the two could
 * differ until a token was reissued.
 */
export function sessionRequiresPasswordChange(session: AppSession | null) {
  return session?.mustChangePassword === true;
}

export function adminGuardRedirect(session: AppSession | null, loading: boolean) {
  if (loading) return null;
  if (sessionRequiresPasswordChange(session)) return '/reset-password?required=1';
  return session ? null : '/login';
}
