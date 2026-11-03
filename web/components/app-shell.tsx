'use client';

import type { ReactNode } from 'react';

import { AppHeader } from '@/components/app-header';
import { AppSidebar } from '@/components/app-sidebar';
import { ConsoleShellProvider } from '@/components/console-shell-context';
import { ImportDockProvider } from '@/components/import-dock';
import { JobberShell } from '@/components/jobber-shell/jobber-shell';
import { PageSearchProvider } from '@/components/page-search';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AdminGuard } from '@/lib/auth';
import type { ConsoleShell } from '@/lib/console-shell';

/** The console's own frame: the sidebar, the breadcrumb header, the page. */
function ClassicShell({ children, defaultSidebarOpen }: { children: ReactNode; defaultSidebarOpen: boolean }) {
  return (
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
        {/* The right margin a little wider than the left: the imports handle
            lives against the right edge, and this keeps it off the content. */}
        <main className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 p-4 pr-6 sm:p-5 sm:pr-7">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Everything around a page: the access check, the import dock, the header's
 * borrowed list search, and one of the two frames (lib/console-shell.ts).
 *
 * The providers sit above the frame on purpose. Switching frame remounts the
 * frame and the page inside it, but a minimized import and the data already
 * loaded live up here and survive it, so the page comes back at once.
 */
export function AppShell({
  children,
  defaultSidebarOpen = true,
  shell = 'classic',
}: {
  children: ReactNode;
  defaultSidebarOpen?: boolean;
  shell?: ConsoleShell;
}) {
  return (
    <AdminGuard>
      <ConsoleShellProvider shell={shell}>
        {/* Outside the sidebar so a minimized import is pinned to the viewport
            rather than to the scrolling content, and above every route so
            navigating to the next property does not lose sight of it. */}
        <ImportDockProvider>
          {/* A list page lends the header its search; see `page-search`. */}
          <PageSearchProvider>
            {shell === 'jobber' ? (
              <JobberShell defaultSidebarOpen={defaultSidebarOpen}>{children}</JobberShell>
            ) : (
              <ClassicShell defaultSidebarOpen={defaultSidebarOpen}>{children}</ClassicShell>
            )}
          </PageSearchProvider>
        </ImportDockProvider>
      </ConsoleShellProvider>
    </AdminGuard>
  );
}
