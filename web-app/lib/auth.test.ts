import type { Session } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { adminGuardRedirect, sessionRequiresPasswordChange } from './auth-session';

describe('temporary-password routing', () => {
  it('detects the server-controlled password-change flag', () => {
    const session = {
      user: { app_metadata: { must_change_password: true } },
    } as unknown as Session;
    expect(sessionRequiresPasswordChange(session)).toBe(true);
    expect(sessionRequiresPasswordChange(null)).toBe(false);
  });

  it('does not redirect an authenticated session when profile loading fails', () => {
    const session = {
      user: { app_metadata: { must_change_password: false } },
    } as unknown as Session;
    expect(adminGuardRedirect(session, false)).toBeNull();
    expect(adminGuardRedirect(null, false)).toBe('/login');
  });
});
