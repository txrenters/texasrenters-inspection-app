'use client';

import type { ReactNode } from 'react';

import { AppHeader } from '@/components/app-header';
import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AdminGuard } from '@/lib/auth';

export function AppShell({
  children,
  defaultSidebarOpen = true,
}: {
  children: ReactNode;
  defaultSidebarOpen?: boolean;
}) {
  return (
    <AdminGuard>
      <SidebarProvider defaultOpen={defaultSidebarOpen}>
        <AppSidebar />
        <SidebarInset className="bg-background min-w-0">
          <AppHeader />
          {/* Capped and centred. The old shell let content run the full width of
              a 27" monitor, which put a table's first and last column a head-turn
              apart and stretched a two-field form across 2,000px.

              Padding is 16px, and 20px only once there is room for it. This is a
              queue-scanning console: the outer gutter is the cheapest place to
              buy back vertical space, and 24px of it bought nothing. */}
          <main className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 p-4 sm:p-5">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </AdminGuard>
  );
}
