'use client';

import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Fragment, Suspense } from 'react';

import { NavigationSection } from '@/components/app-sidebar';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { activeNavigationChild, isAdminNavigationItemActive, type AdminNavigationItem } from '@/lib/admin-navigation';
import { usePermissions } from '@/lib/auth';
import { getJobberNavigation } from '@/lib/jobber-navigation';
import { useUnassignedCount } from '@/lib/queries';

import { CreateMenu } from './create-menu';
import { JOBBER_NAV_ROW } from './nav-row';

/**
 * The sections, split by hairlines as Jobber splits its own. `activeType` is
 * threaded in for the same reason as the classic sidebar's tree: reading the
 * search param here unguarded would opt every admin route out of prerendering.
 */
function JobberNavigationTree({
  activeType,
  counts,
  onNavigate,
  sections,
}: {
  activeType: string | null;
  counts: Record<string, number | undefined>;
  onNavigate: () => void;
  sections: AdminNavigationItem[][];
}) {
  const pathname = usePathname();

  return (
    <>
      {sections.map((section, index) => (
        <Fragment key={section[0]?.href ?? index}>
          <SidebarSeparator className="my-2" />
          <SidebarMenu className="gap-1">
            {section.map((item) => {
              const active = isAdminNavigationItemActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.href}>
                  {item.children ? (
                    <NavigationSection
                      activeChild={activeNavigationChild(item, pathname, activeType)}
                      className={JOBBER_NAV_ROW}
                      count={counts[item.href]}
                      iconClassName=""
                      isActive={active}
                      item={item}
                      onNavigate={onNavigate}
                    />
                  ) : (
                    <SidebarMenuButton asChild className={JOBBER_NAV_ROW} isActive={active} tooltip={item.title}>
                      <Link aria-current={active ? 'page' : undefined} href={item.href} onClick={onNavigate}>
                        <Icon aria-hidden />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </Fragment>
      ))}
    </>
  );
}

function JobberNavigationTreeWithActiveType(props: Omit<Parameters<typeof JobberNavigationTree>[0], 'activeType'>) {
  return <JobberNavigationTree {...props} activeType={useSearchParams().get('type')} />;
}

/**
 * Jobber's sidebar: Create at the top, the day, the records, the tools, and a
 * collapse arrow at the foot. It starts below the top bar, which spans the
 * whole window as Jobber's does, so the fixed container is moved down by the
 * bar's height (the same token the sticky table headers use).
 *
 * The administration pages are not here; they are behind the gear in the top
 * bar, where Jobber keeps its own (settings-menu.tsx).
 */
export function JobberSidebar() {
  const { has } = usePermissions();
  const { isMobile, setOpenMobile, state, toggleSidebar } = useSidebar();
  const { sidebar } = getJobberNavigation(has);
  const unassigned = useUnassignedCount(has('inspections:read'));
  const counts: Record<string, number | undefined> = { '/inspections': unassigned.data };
  const collapsed = state === 'collapsed';

  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar
      aria-label="Application navigation"
      className="top-(--app-header-height) h-[calc(100svh-var(--app-header-height))] group-data-[side=left]:border-r-0"
      collapsible="icon"
    >
      <SidebarContent className="gap-0 overflow-x-hidden px-2 pt-1 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <CreateMenu />
          </SidebarMenuItem>
        </SidebarMenu>
        <Suspense
          fallback={
            <JobberNavigationTree
              activeType={null}
              counts={counts}
              onNavigate={closeMobileNavigation}
              sections={sidebar}
            />
          }
        >
          <JobberNavigationTreeWithActiveType counts={counts} onNavigate={closeMobileNavigation} sections={sidebar} />
        </Suspense>
      </SidebarContent>

      {/* Not on a phone, where the sidebar is a sheet that closes itself. */}
      {isMobile ? null : (
        <SidebarFooter className="px-2 pb-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className={JOBBER_NAV_ROW}
                onClick={toggleSidebar}
                tooltip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                {collapsed ? <ArrowRightIcon aria-hidden /> : <ArrowLeftIcon aria-hidden />}
                <span>{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
