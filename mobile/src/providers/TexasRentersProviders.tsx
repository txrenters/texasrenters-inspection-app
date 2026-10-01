import type { PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';
import {
  focusManager,
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';

import { SessionUnavailableError } from '../auth/session';
import { queryKeys } from '../features/queries';
import { reconcileMobileState } from '../features/state-consistency';
import { reportError } from '../lib/error-log';
import { repositories } from '../repositories';
import { InspectionReminderSync } from '../realtime/InspectionReminderSync';
import { TechnicianRealtimeProvider } from '../realtime/TechnicianRealtimeProvider';
import { ApiConnectionError, SessionExpiredError } from '../storage/offline-record-cache';

/**
 * One place to react to a dead session.
 *
 * Any query or mutation may be the first to discover the session has gone.
 * Handling it per-screen produced the same raw sentence on whichever screen the
 * technician happened to be on, with no way forward. Instead, drop the cached
 * user: the `(app)` layout guard reads `useCurrentUser` and redirects to
 * sign-in as soon as it resolves to null.
 */
function handleQueryError(client: QueryClient, error: unknown, source: string) {
  if (error instanceof SessionExpiredError) {
    // Resolved to null, not removed.
    //
    // `removeQueries` looked like it avoided a loop, but the query still had a
    // mounted observer: removing it dropped the cache entry, react-query
    // immediately refetched for that observer, the dead session produced
    // another SessionExpiredError, and round it went. `isLoading` never
    // settled, so the app sat on "Verifying secure access…" forever with no
    // way to reach sign-in.
    //
    // Writing null instead gives the guard a definite answer on the first
    // failure, and the router sends the technician to sign-in.
    client.setQueryData(queryKeys.currentUser, null);
    // Clears the dead tokens too, so the next launch starts from a clean
    // session rather than repeating this on every cold start.
    void repositories.auth.signOut().catch(() => undefined);
    return;
  }
  // A locked phone, not a fault: the request goes when the app is next open.
  if (error instanceof SessionUnavailableError) return;
  void reportError(error, { source });
}

/**
 * The app is "focused" while it is on screen, and not while it is behind the
 * lock screen or another app.
 *
 * Every poll here says `refetchIntervalInBackground: false`, and none of them
 * ever stopped: react-query watches a browser window's visibility, which React
 * Native does not have, so it read every moment as focused unless told
 * otherwise -- and nothing told it. An iPhone keeps the app running behind the
 * lock screen for the location task, so the dashboard, the job list and the
 * office's requests were fetched every minute from a pocket all evening, each
 * one needing a token the locked keychain would not give up (11,838 refused
 * reads in the office's error log, 2026-09-14 to 2026-10-01). The web build
 * keeps react-query's own window handling.
 */
if (Platform.OS !== 'web')
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener('change', (state) => setFocused(state === 'active'));
    return () => subscription.remove();
  });

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handleQueryError(queryClient, error, 'query'),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handleQueryError(queryClient, error, 'mutation'),
  }),
  defaultOptions: {
    queries: {
      /**
       * A dead session will not recover on retry, and retrying delays the
       * redirect the technician needs — so it is never retried.
       *
       * A connection failure is the opposite: almost always transient. The
       * previous policy allowed one retry 500 ms later, which is shorter than
       * anything that actually causes one. A backend redeploy takes ten to
       * fifteen seconds, and both attempts landed inside the same outage, so a
       * routine restart showed a technician in the field a red error about the
       * API being unreachable. Cellular hand-offs behave the same way.
       *
       * Three attempts with backoff spans roughly ten seconds, which rides out
       * a container restart without the screen ever admitting it happened. Two
       * things make that safe rather than merely hopeful: these are GETs, and
       * mutations stay at `retry: false` below, because a write that may have
       * been applied must never be replayed on a guess.
       */
      retry: (failureCount, error) => {
        if (error instanceof SessionExpiredError) return false;
        return error instanceof ApiConnectionError ? failureCount < 3 : failureCount < 1;
      },
      retryDelay: (failureCount) => Math.min(500 * 2 ** failureCount, 8_000),
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
      structuralSharing: reconcileMobileState,
    },
    mutations: { retry: false },
  },
});

export function TexasRentersProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <TechnicianRealtimeProvider>
        <InspectionReminderSync />
        {children}
      </TechnicianRealtimeProvider>
    </QueryClientProvider>
  );
}
