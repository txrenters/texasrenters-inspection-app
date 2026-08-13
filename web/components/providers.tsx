'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';

import { AuthProvider } from '@/lib/auth';
import { NotificationsProvider } from '@/lib/notifications';
import { AdminRealtimeProvider } from '@/lib/realtime';
import { reconcileServerState } from '@/lib/state-consistency';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 10 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
            structuralSharing: reconcileServerState,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // Same key as the old app, so anyone who already picked a theme keeps it.
      storageKey="texasrenters-admin-theme"
    >
      <QueryClientProvider client={client}>
        {/* Inside AuthProvider, which owns the access token the socket
            authenticates with, and inside QueryClientProvider, whose cache it
            invalidates when an event lands. */}
        <AuthProvider>
          <NotificationsProvider>
            {/* Outside AdminRealtimeProvider, which is what feeds it. */}
            <AdminRealtimeProvider>{children}</AdminRealtimeProvider>
          </NotificationsProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
