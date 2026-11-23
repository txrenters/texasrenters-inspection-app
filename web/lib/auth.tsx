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
import {
  getSession,
  onSessionChange,
  SessionUnavailableError,
  signOut as endSession,
  type AppSession,
} from './session';

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

/** How soon a session that could not be renewed on loading is tried again. */
export const SESSION_RETRY_MS = 10_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestId = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async (): Promise<AuthRefreshResult> => {
    const requestId = (refreshRequestId.current += 1);
    clearTimeout(retry.current);
    setLoading(true);
    setError(null);
    let next: AppSession | null;
    try {
      next = await getSession();
    } catch (reason) {
      if (requestId !== refreshRequestId.current) return { profile: null, error: null };
      // The renewal got no answer (SessionUnavailableError), so nobody knows
      // the session has ended. Still restoring, then -- "loading" is what
      // keeps AdminGuard from sending a remembered sign-in to the login page
      // over a dropped connection or a server restarting for a release -- and
      // tried again.
      const message =
        reason instanceof SessionUnavailableError ? reason.message : new SessionUnavailableError().message;
      setError(message);
      retry.current = setTimeout(() => void refresh(), SESSION_RETRY_MS);
      return { profile: null, error: message };
    }
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
    const unsubscribe = onSessionChange((nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        refreshRequestId.current += 1;
        clearTimeout(retry.current);
        setProfile(null);
        setError(null);
        setLoading(false);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(retry.current);
    };
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
        clearTimeout(retry.current);
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

  // With the reason, while a renewal that got no answer is tried again.
  if (auth.loading)
    return <CenteredState busy description={auth.error ?? undefined} title="Restoring secure session…" />;

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
