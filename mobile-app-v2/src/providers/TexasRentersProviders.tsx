import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { reconcileMobileState } from '../features/state-consistency';
import { InspectionReminderSync } from '../realtime/InspectionReminderSync';
import { TechnicianRealtimeProvider } from '../realtime/TechnicianRealtimeProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
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
