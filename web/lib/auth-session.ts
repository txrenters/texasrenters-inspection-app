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

/**
 * Whether this profile may use the console, and what to say when it may not.
 *
 * `SYSTEM_ADMIN` is the bootstrap account. Everyone else needs at least one
 * effective permission, and those come only from administrator-created roles —
 * a membership label grants nothing on its own.
 *
 * Which means two quite different situations fail this check, and they used to
 * be told the same thing. Somebody who was granted console access but has not
 * been assigned a role yet holds a console membership and no permissions;
 * telling them they are "not authorized" sends both them and their
 * administrator looking for a problem that is really an unfinished second step
 * — the grant deliberately assigns no roles. A technician with no console
 * access at all holds only their technician membership, and for them "not
 * authorized" is the accurate answer.
 *
 * Returns null when the profile is allowed in.
 */
export function consoleAccessError(profile: {
  memberships: Array<{ role: string }>;
  permissions: readonly string[];
}) {
  const isBootstrapAdmin = profile.memberships.some(({ role }) => role === 'SYSTEM_ADMIN');
  if (isBootstrapAdmin || profile.permissions.length > 0) return null;
  return profile.memberships.some(({ role }) => role !== 'INSPECTION_TECHNICIAN')
    ? 'This account can reach the console but has no role assigned yet, so there is nothing it can do. Ask an administrator to assign one.'
    : 'This account is not authorized for the administrator application.';
}
