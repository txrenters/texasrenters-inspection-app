import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppThemeProvider } from '../theme';
import { InspectionReminderSync } from '../realtime/InspectionReminderSync';
import { TechnicianRealtimeProvider } from '../realtime/TechnicianRealtimeProvider';
import { reconcileMobileState } from '../features/state-consistency';

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

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TechnicianRealtimeProvider>
            <InspectionReminderSync />
            {children}
          </TechnicianRealtimeProvider>
        </QueryClientProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}
