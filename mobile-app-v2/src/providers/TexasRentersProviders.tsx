import type { PropsWithChildren } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { queryKeys } from '../features/queries';
import { reconcileMobileState } from '../features/state-consistency';
import { reportError } from '../lib/error-log';
import { InspectionReminderSync } from '../realtime/InspectionReminderSync';
import { TechnicianRealtimeProvider } from '../realtime/TechnicianRealtimeProvider';
import { SessionExpiredError } from '../storage/offline-record-cache';

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
    // Remove rather than invalidate — invalidate would refetch with the same
    // dead session and loop.
    client.removeQueries({ queryKey: queryKeys.currentUser });
    return;
  }
  void reportError(error, { source });
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handleQueryError(queryClient, error, 'query'),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handleQueryError(queryClient, error, 'mutation'),
  }),
  defaultOptions: {
    queries: {
      // A dead session will not recover on retry, and retrying delays the
      // redirect the technician needs.
      retry: (failureCount, error) => !(error instanceof SessionExpiredError) && failureCount < 1,
      retryDelay: 500,
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
