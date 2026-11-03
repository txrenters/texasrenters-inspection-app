'use client';

import { useLayoutEffect, type CSSProperties, type ReactNode } from 'react';

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

import { JobberSidebar } from './jobber-sidebar';
import { JobberTopBar } from './jobber-top-bar';

/**
 * Jobber's frame around the console (see lib/console-shell.ts for the choice).
 *
 *   ┌───────────────────────────────── top bar (60px) ─┐
 *   │ sidebar │ ╭─ the page, a white sheet ───────────╮ │
 *   │ 232px / │ │                                     │ │
 *   │ 56px    │ │                                     │ │
 *
 * Measured from Jobber: a 60px bar across the whole window, a sidebar (56px
 * collapsed) on the same taupe, and the page as a white sheet with a 1px
 * border and rounded top corners. Jobber's sidebar is 188px; ours is wider
 * (see the style below).
 *
 * The document still scrolls, as in the classic shell, rather than the sheet
 * scrolling inside itself as Jobber's does. Sticky table headers, the area
 * panel's sticky media and the plan's fill-height measuring all assume the
 * window is the scroller; keeping it means not one page had to change. The
 * bar and the sidebar are pinned instead, so it looks the same.
 *
 * `data-shell="jobber"` switches the palette (globals.css). It is set on this
 * frame for the first paint, and on <html> as well once mounted, because
 * dialogs, menus and toasts portal to <body>, outside the frame.
 */
export function JobberShell({
  children,
  defaultSidebarOpen = true,
}: {
  children: ReactNode;
  defaultSidebarOpen?: boolean;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.shell = 'jobber';
    return () => {
      delete root.dataset.shell;
    };
  }, []);

  return (
    <SidebarProvider
      className="bg-sidebar flex-col"
      data-shell="jobber"
      defaultOpen={defaultSidebarOpen}
      // 232px rather than Jobber's 188: our page names are longer than
      // Jobber's ("Move-ins & move-outs", "Benefit package plan"), and a
      // sidebar that truncates them makes the office hover to read them.
      style={{ '--sidebar-width': '14.5rem', '--sidebar-width-icon': '3.5rem' } as CSSProperties}
    >
      <JobberTopBar />
      <div className="flex min-h-0 w-full flex-1">
        <JobberSidebar />
        <SidebarInset className="bg-sidebar min-w-0">
          {/* The sheet. Full height under the bar, so a short page still
              reads as a page rather than a card floating in the frame. */}
          <div className="bg-background min-h-[calc(100svh-var(--app-header-height))] min-w-0 rounded-t-lg border border-b-0">
            {/* Capped and centred as in the classic shell; the right margin a
                little wider for the imports handle against the right edge. */}
            <div className="mx-auto w-full max-w-[1600px] min-w-0 p-4 pr-6 sm:p-6 sm:pr-8">{children}</div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
