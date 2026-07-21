'use client';

import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { AdminProfile } from '@texasrenters/shared';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from './api';
import { adminGuardRedirect, sessionRequiresPasswordChange } from './auth-session';
import { supabase } from './supabase';

const ADMIN_ROLES = new Set(['SYSTEM_ADMIN', 'PROPERTY_ADMIN', 'INSPECTION_SUPERVISOR']);

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

  const refresh = async () => {
    setLoading(true);
    setError(null);
    const { data } = await supabase().auth.getSession();
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
      if (!next.isActive) throw new Error('Your administrator account is disabled.');
      if (!next.memberships.some(({ role }) => ADMIN_ROLES.has(role)))
        throw new Error('This account is not authorized for the administrator application.');
      setProfile(next);
      return { profile: next, error: null };
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : 'Administrator access could not be verified.';
      setProfile(null);
      setError(message);
      return { profile: null, error: message };
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const { data } = supabase().auth.onAuthStateChange(
      (_event: AuthChangeEvent, nextSession: Session | null) => {
        setSession(nextSession);
        if (!nextSession) setProfile(null);
      },
    );
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      loading,
      error,
      refresh,
      signOut: async () => {
        await supabase().auth.signOut({ scope: 'local' });
        setSession(null);
        setProfile(null);
      },
    }),
    [session, profile, loading, error],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}

export function AdminGuard({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  useEffect(() => {
    const destination = adminGuardRedirect(auth.session, auth.loading);
    if (destination) router.replace(destination);
  }, [auth.loading, auth.profile, auth.session, router]);
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
