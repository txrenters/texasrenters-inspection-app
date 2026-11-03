'use client';

import Link from 'next/link';

import { CommandPalette } from '@/components/command-palette';
import { HeaderClocks } from '@/components/header-clocks';
import { NotificationBell } from '@/components/notification-bell';
import { ThemeToggle } from '@/components/theme-toggle';
import { SidebarTrigger } from '@/components/ui/sidebar';

import { JobberSettingsMenu } from './settings-menu';

/**
 * Jobber's top bar: the business's name at the left, a wide search, and a row
 * of round-cornered icon buttons ending in the gear. It spans the whole window,
 * above the sidebar, on the same taupe as the sidebar, so the page below reads
 * as a sheet laid inside one frame.
 *
 * The search is the console's own (CommandPalette): it finds inspections,
 * properties, technicians and pages, opens on "/" as Jobber's does, and on a
 * list page it is that list's search, as in the classic header.
 *
 * Icon buttons are drawn at Jobber's 40px with 20px glyphs. The size is set
 * from here, on the buttons the shared header controls render, rather than by
 * giving each of them a Jobber variant.
 */
export function JobberTopBar() {
  return (
    <header className="bg-sidebar text-sidebar-foreground sticky top-0 z-30 flex h-(--app-header-height) shrink-0 items-center gap-2 px-2 sm:gap-3 sm:px-3">
      <SidebarTrigger aria-label="Open navigation" className="size-10 md:hidden" />
      <Link
        aria-label="TexasRenters Inspection - go to Home"
        className="focus-visible:ring-sidebar-ring flex min-w-0 items-center gap-2.5 rounded-md px-1 outline-none focus-visible:ring-2"
        href="/dashboard"
      >
        {/* The console's own mark and name: this is the TexasRenters console in
            a familiar frame, not Jobber, and must never read as Jobber. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" className="size-8 shrink-0 rounded-md" src="/brand/logo-mark-tile.svg" />
        <span className="text-heading hidden truncate text-sm font-semibold sm:inline">TexasRenters Inspection</span>
      </Link>

      <div className="ml-auto flex min-w-0 items-center gap-1 [&>[data-slot=button]]:size-10 [&>[data-slot=button]_svg]:size-5!">
        <div className="mr-1 min-w-0">
          <CommandPalette variant="jobber" />
        </div>
        <HeaderClocks />
        <NotificationBell />
        <ThemeToggle />
        <JobberSettingsMenu />
      </div>
    </header>
  );
}
