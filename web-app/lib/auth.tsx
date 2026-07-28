'use client';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { AdminProfile } from '@texasrenters/shared';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { api } from './api';
import { adminGuardRedirect, sessionRequiresPasswordChange } from './auth-session';
import { supabase } from './supabase';

interface AuthState {
  session: Session | null;
  profile: AdminProfile | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AuthRefreshResult>;
  signOut: () => Promise<void>;
}

interface AuthRefreshResult {
  profile: AdminProfile | null;
  error: string | null;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = (refreshRequestId.current += 1);
    setLoading(true);
    setError(null);
    const { data } = await supabase().auth.getSession();
    if (requestId !== refreshRequestId.current) return { profile: null, error: null };
    setSession(data.session);
    if (!data.session) {
      setProfile(null);
      setLoading(false);
      return { profile: null, error: null };
    }
    if (sessionRequiresPasswordChange(data.session)) {
      setProfile(null);
      setLoading(false);
      return { profile: null, error: null };
    }
    try {
      const next = await api<AdminProfile>('/api/v1/admin/profile');
      if (requestId !== refreshRequestId.current) return { profile: null, error: null };
      if (!next.isActive) throw new Error('Your administrator account is disabled.');
      // SYSTEM_ADMIN is the bootstrap account. Every other web user needs at
      // least one effective permission from an administrator-created role.
      const authorized =
        next.memberships.some(({ role }) => role === 'SYSTEM_ADMIN') || next.permissions.length > 0;
      if (!authorized)
        throw new Error('This account is not authorized for the administrator application.');
      setProfile(next);
      return { profile: next, error: null };
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'Administrator access could not be verified.';
      if (requestId !== refreshRequestId.current) return { profile: null, error: null };
      setProfile(null);
      setError(message);
      return { profile: null, error: message };
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const { data } = supabase().auth.onAuthStateChange(
      (_event: AuthChangeEvent, nextSession: Session | null) => {
        setSession(nextSession);
        if (!nextSession) {
          refreshRequestId.current += 1;
          setProfile(null);
          setError(null);
          setLoading(false);
        }
      },
    );
    return () => data.subscription.unsubscribe();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      loading,
      error,
      refresh,
      signOut: async () => {
        refreshRequestId.current += 1;
        await supabase().auth.signOut({ scope: 'local' });
        setSession(null);
        setProfile(null);
        setError(null);
        setLoading(false);
      },
    }),
    [session, profile, loading, error, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}

/**
 * Client-side permission gate for navigation and controls. The backend remains
 * authoritative on every request; this only hides UI the user cannot use.
 */
export function usePermissions() {
  const { profile } = useAuth();
  const set = useMemo(() => new Set(profile?.permissions ?? []), [profile?.permissions]);
  return {
    permissions: profile?.permissions ?? [],
    has: (permission: string) => set.has(permission),
    hasAny: (...permissions: string[]) => permissions.some((permission) => set.has(permission)),
  };
}

export function AdminGuard({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    const destination = adminGuardRedirect(auth.session, auth.loading);
    if (destination) router.replace(destination);
  }, [auth.loading, auth.profile, auth.session, router]);
  if (!auth.loading && !auth.session) return null;
  if (auth.loading)
    return (
      <div className="center-state">
        <div className="spinner" />
        <p>Restoring secure session…</p>
      </div>
    );
  if (auth.session && auth.error)
    return (
      <div className="center-state">
        <h1>Administrator data unavailable</h1>
        <p>{auth.error}</p>
        <div className="center-state-actions">
          <button className="button button-primary" onClick={() => void auth.refresh()}>
            Retry
          </button>
          <button
            className="button button-secondary"
            onClick={() => void auth.signOut().then(() => router.replace('/login'))}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  if (!auth.profile)
    return (
      <div className="center-state">
        <h1>Administrator access required</h1>
        <p>{auth.error ?? 'Redirecting to sign in…'}</p>
      </div>
    );
  return children;
}
