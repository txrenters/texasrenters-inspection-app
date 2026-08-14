'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, Suspense } from 'react';

import { CommandPalette } from '@/components/command-palette';
import { HeaderClocks } from '@/components/header-clocks';
import { NotificationBell } from '@/components/notification-bell';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { getAdminBreadcrumbs } from '@/lib/admin-navigation';

/**
 * Sticky, so the breadcrumb and the search stay reachable down a long
 * inspection detail page. The old header scrolled away with the content, which
 * on the charge report meant scrolling back to the top to navigate anywhere.
 *
 * The "Secure workspace" badge the old header carried is gone: it was a static
 * decoration that reported no state and could not become false.
 */
/**
 * Split out for the same reason as the sidebar's tree: the header is mounted by
 * the layout on every admin route, so reading the search param has to sit behind
 * a Suspense boundary. The fallback is the path-only trail, so the crumbs are
 * never missing — at worst the type crumb arrives a beat later.
 */
function Breadcrumbs({ type }: { type?: string | null }) {
  const pathname = usePathname();
  const breadcrumbs = getAdminBreadcrumbs(pathname, type);

  return (
    <BreadcrumbList className="flex-nowrap overflow-hidden">
      {breadcrumbs.map((breadcrumb, index) => (
        <Fragment key={`${breadcrumb.title}-${index}`}>
          {index > 0 ? <BreadcrumbSeparator /> : null}
          <BreadcrumbItem className="min-w-0">
            {breadcrumb.href ? (
              <BreadcrumbLink asChild>
                <Link className="truncate" href={breadcrumb.href}>
                  {breadcrumb.title}
                </Link>
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage className="truncate font-medium">{breadcrumb.title}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
        </Fragment>
      ))}
    </BreadcrumbList>
  );
}

function BreadcrumbsWithType() {
  return <Breadcrumbs type={useSearchParams().get('type')} />;
}

export function AppHeader() {
  return (
    // Opaque, not `bg-background/75` with a blur. A translucent bar over a dense
    // table shows the rows sliding underneath it, and the column headers now pin
    // directly below this one — two stacked translucent layers over moving
    // content is unreadable. Height comes from `--app-header-height` because the
    // table headers offset themselves by it.
    <header className="bg-background sticky top-0 z-30 flex h-[var(--app-header-height)] shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger aria-label="Toggle application navigation" className="-ml-1 shrink-0" />
      <Separator className="mr-1 !h-4" orientation="vertical" />
      <Breadcrumb className="min-w-0 flex-1">
        <Suspense fallback={<Breadcrumbs />}>
          <BreadcrumbsWithType />
        </Suspense>
      </Breadcrumb>

      <div className="flex shrink-0 items-center gap-2">
        <div className="hidden sm:block">
          <CommandPalette />
        </div>
        <HeaderClocks />
        {/* Before the theme toggle: this is the control that changes, and the
            one somebody scans for on returning to their desk. */}
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  );
}
