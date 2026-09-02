'use client';

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

import { CenteredState } from '@/components/centered-state';
import { Button } from '@/components/ui/button';

import { api } from './api';
import { adminGuardRedirect, consoleAccessError, sessionRequiresPasswordChange } from './auth-session';
import { getSession, onSessionChange, signOut as endSession, type AppSession } from './session';

interface AuthState {
  session: AppSession | null;
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
  const [session, setSession] = useState<AppSession | null>(null);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = (refreshRequestId.current += 1);
    setLoading(true);
    setError(null);
    const next = await getSession();
    if (requestId !== refreshRequestId.current) return { profile: null, error: null };
    setSession(next);
    if (!next) {
      setProfile(null);
      setLoading(false);
      return { profile: null, error: null };
    }
    if (sessionRequiresPasswordChange(next)) {
      setProfile(null);
      setLoading(false);
      return { profile: null, error: null };
    }
    try {
      const profileData = await api<AdminProfile>('/api/v1/admin/profile');
      if (requestId !== refreshRequestId.current) return { profile: null, error: null };
      if (!profileData.isActive) throw new Error('Your administrator account is disabled.');
      const refusal = consoleAccessError(profileData);
      if (refusal) throw new Error(refusal);
      setProfile(profileData);
      return { profile: profileData, error: null };
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
    // Signing out in one tab must clear the others. Cookies raise no event, so
    // this watches the value rather than subscribing to one.
    return onSessionChange((nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        refreshRequestId.current += 1;
        setProfile(null);
        setError(null);
        setLoading(false);
      }
    });
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
        await endSession();
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
    return <CenteredState busy title="Restoring secure session…" />;

  if (auth.session && auth.error)
    return (
      <CenteredState
        tone="destructive"
        title="Administrator data unavailable"
        description={auth.error}
      >
        <Button onClick={() => void auth.refresh()}>Retry</Button>
        <Button
          variant="outline"
          onClick={() => void auth.signOut().then(() => router.replace('/login'))}
        >
          Sign out
        </Button>
      </CenteredState>
    );

  if (!auth.profile)
    return (
      <CenteredState
        title="Administrator access required"
        description={auth.error ?? 'Redirecting to sign in…'}
      />
    );

  return children;
}
