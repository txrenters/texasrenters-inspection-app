import type { Session } from '@supabase/supabase-js';

export function sessionRequiresPasswordChange(session: Session | null) {
  return session?.user.app_metadata.must_change_password === true;
}

export function adminGuardRedirect(session: Session | null, loading: boolean) {
  if (loading) return null;
  if (sessionRequiresPasswordChange(session)) return '/reset-password?required=1';
  return session ? null : '/login';
}
