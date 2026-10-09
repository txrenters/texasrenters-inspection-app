'use client';

import {
  ChevronRightIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  SettingsIcon,
  UserRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useId, useState } from 'react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  activeNavigationChild,
  getVisibleAdminNavigation,
  isAdminNavigationItemActive,
  navigationChildHref,
  type AdminNavigationChild,
  type AdminNavigationGroup,
  type AdminNavigationItem,
} from '@/lib/admin-navigation';
import { useAuth, usePermissions } from '@/lib/auth';
import { useUnassignedCount } from '@/lib/queries';
import { initials } from '@/lib/format';
import { APP_VERSION_LABEL } from '@/lib/app-version';
import { cn } from '@/lib/utils';

/**
 * Navigation is words, not words with an icon each (console-development, as
 * the canvas draws it): fifteen glyphs down the sidebar restated fifteen labels.
 * The icons come back on the collapsed rail, where they are all there is.
 */
const NAV_ICON = 'hidden group-data-[collapsible=icon]:block';

/**
 * A nav item that groups filtered views of one route, rather than being a
 * destination itself.
 *
 * The header does not navigate: the children are where you go, and a parent that
 * also navigated would land you on the combined list the split exists to
 * replace. It toggles them instead.
 */
export function NavigationSection({
  activeChild,
  count,
  isActive,
  item,
  onNavigate,
}: {
  activeChild: AdminNavigationChild | undefined;
  /** Work waiting in this section, shown in amber beside its name. */
  count?: number;
  isActive: boolean;
  item: AdminNavigationItem;
  onNavigate: () => void;
}) {
  const { isMobile, setOpen: setSidebarOpen, state } = useSidebar();
  // Starts open when you are already inside the section — landing on a move-out
  // list with its own nav collapsed would hide where you are.
  const [open, setOpen] = useState(isActive);
  const listId = `${useId()}-section`;
  const Icon = item.icon;

  /**
   * On the icon rail the sub-items are hidden by the sidebar's own styles, so
   * toggling there would operate on something invisible — and, with the header
   * no longer a link, leave the section unreachable while collapsed. Widen the
   * sidebar and show them instead of honouring the toggle.
   */
  const iconRail = state === 'collapsed' && !isMobile;
  const expanded = open && !iconRail;

  /*
   * Deliberately not Radix's `Collapsible` with `CollapsibleTrigger asChild`,
   * which is the shape the shadcn sidebar example uses.
   *
   * `SidebarMenuButton` given a `tooltip` returns a `<Tooltip>` root — a
   * component that renders no DOM of its own. `asChild` would clone *that*, and
   * the trigger's `onClick` and aria wiring would be dropped on a component
   * that ignores them, leaving a header that looks interactive and does
   * nothing. Owning the state here keeps the tooltip, which is the only label
   * this button has once the sidebar is collapsed.
   */
  const toggle = () => {
    if (iconRail) {
      setSidebarOpen(true);
      setOpen(true);
      return;
    }
    setOpen(!open);
  };

  return (
    <>
      <SidebarMenuButton
        aria-controls={listId}
        aria-expanded={expanded}
        // The accent marks ONE place. When the active child is on screen it
        // carries the mark, and the section header stays plain; collapsed (or
        // on the icon rail) the header is all there is, so it carries it.
        isActive={isActive && !(expanded && activeChild)}
        onClick={toggle}
        tooltip={item.title}
      >
        <Icon aria-hidden className={NAV_ICON} />
        <span>{item.title}</span>
        {count ? (
          <span className="text-warning ml-auto font-mono text-[11px] tabular-nums group-data-[collapsible=icon]:hidden">
            {count > 99 ? '99+' : count}
            <span className="sr-only"> waiting for a technician</span>
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'transition-transform duration-200 group-data-[collapsible=icon]:hidden',
            !count && 'ml-auto',
            expanded && 'rotate-90',
          )}
        />
      </SidebarMenuButton>
      {expanded ? (
        <SidebarMenuSub
          className="animate-in fade-in-0 slide-in-from-top-1 duration-150"
          id={listId}
        >
          {item.children?.map((child) => {
            const childActive = activeChild?.type === child.type;
            return (
              <SidebarMenuSubItem key={child.type}>
                {/* The row grows rather than clipping. The base style is
                    `flex h-7 … overflow-hidden`, and its truncate rule only
                    reaches a `span` child — a bare text label wraps inside a
                    fixed 28px box and spills over the rows above and below,
                    which is what "Supra + lockbox placement" did. Height is
                    left to the content and the label is allowed two lines,
                    because the office's wording is theirs, not ours to
                    abbreviate until it fits. */}
                <SidebarMenuSubButton
                  asChild
                  className="h-auto min-h-7 py-1 leading-snug"
                  isActive={childActive}
                >
                  <Link
                    aria-current={childActive ? 'page' : undefined}
                    href={navigationChildHref(item, child)}
                    onClick={onNavigate}
                  >
                    {child.title}
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      ) : null}
    </>
  );
}

/**
 * The navigation tree.
 *
 * `activeType` is threaded in rather than read here so the whole tree can render
 * from the Suspense fallback too — the sidebar is mounted by the layout on every
 * admin route, so an unguarded `useSearchParams` in it would opt every one of
 * them out of prerendering. The fallback is this same tree with no sub-item
 * highlighted, which is why there is no visible flash.
 */
function NavigationTree({
  activeType,
  counts,
  groups,
  onNavigate,
}: {
  activeType: string | null;
  /** Work waiting, by route: shown beside the item. */
  counts: Record<string, number | undefined>;
  groups: AdminNavigationGroup[];
  onNavigate: () => void;
}) {
  const pathname = usePathname();

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup className="gap-1 p-0" key={group.title}>
          <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const active = isAdminNavigationItemActive(pathname, item.href);
                const activeChild = activeNavigationChild(item, pathname, activeType);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    {item.children ? (
                      <NavigationSection
                        activeChild={activeChild}
                        count={counts[item.href]}
                        isActive={active}
                        item={item}
                        onNavigate={onNavigate}
                      />
                    ) : (
                      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                        <Link
                          aria-current={active ? 'page' : undefined}
                          href={item.href}
                          onClick={onNavigate}
                        >
                          <Icon aria-hidden className={NAV_ICON} />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

function NavigationTreeWithActiveType(props: {
  counts: Record<string, number | undefined>;
  groups: AdminNavigationGroup[];
  onNavigate: () => void;
}) {
  const activeType = useSearchParams().get('type');
  return <NavigationTree {...props} activeType={activeType} />;
}

export function AppSidebar() {
  const router = useRouter();
  const auth = useAuth();
  const { has } = usePermissions();
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = getVisibleAdminNavigation(has);
  const unassigned = useUnassignedCount(has('inspections:read'));
  const counts: Record<string, number | undefined> = { '/inspections': unassigned.data };
  const displayName = auth.profile?.displayName ?? 'Administrator';
  const accessLabel = auth.profile?.memberships.some(({ role }) => role === 'SYSTEM_ADMIN')
    ? 'System admin'
    : 'Custom access';

  const closeMobileNavigation = () => {
    if (isMobile) setOpenMobile(false);
  };

  const signOut = async () => {
    await auth.signOut();
    router.replace('/login');
  };

  return (
    <Sidebar aria-label="Application navigation" collapsible="icon">
      <SidebarHeader className="h-12 justify-center border-b px-3">
        <Link
          aria-label="TexasRenters Inspection Admin - go to dashboard"
          className="focus-visible:ring-sidebar-ring flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2"
          href="/dashboard"
          onClick={closeMobileNavigation}
        >
          {/* The brand mark alone, small, with the name in plain text beside it
              (console-development). The full-colour horizontal lockup was the
              loudest thing on every page; the mark keeps the brand -- navy tile,
              green house -- at a size that sits quietly in the corner. Collapsed
              to the rail, the mark is all that shows. Decorative: the Link
              carries the accessible name. `next/image` would need
              `dangerouslyAllowSVG` for no gain on a 12KB vector. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt=""
            className="size-6 shrink-0 rounded-md group-data-[collapsible=icon]:size-7"
            src="/brand/logo-mark-tile.svg"
          />
          <span className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-[13px] font-semibold tracking-tight">TexasRenters</span>
            <span className="text-muted-foreground font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase">
              Inspection
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 py-3">
        <Suspense
          fallback={
            <NavigationTree activeType={null} counts={counts} groups={groups} onNavigate={closeMobileNavigation} />
          }
        >
          <NavigationTreeWithActiveType counts={counts} groups={groups} onNavigate={closeMobileNavigation} />
        </Suspense>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  aria-label="Open account menu"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  size="lg"
                  tooltip="Account menu"
                >
                  <Avatar className="size-8 rounded-full">
                    <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground rounded-full text-xs font-semibold">
                      {initials(displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{displayName}</span>
                    <span className="text-muted-foreground truncate text-xs">{accessLabel}</span>
                  </span>
                  <ChevronsUpDownIcon aria-hidden className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-56"
                side={isMobile ? 'bottom' : 'right'}
                sideOffset={8}
              >
                <DropdownMenuLabel className="font-normal">
                  <span className="text-foreground block truncate font-medium">{displayName}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {auth.profile?.email ?? accessLabel}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/profile" onClick={closeMobileNavigation}>
                    <UserRoundIcon aria-hidden />
                    Profile
                  </Link>
                </DropdownMenuItem>
                {has('integrations:read') ? (
                  <DropdownMenuItem asChild>
                    <Link href="/settings" onClick={closeMobileNavigation}>
                      <SettingsIcon aria-hidden />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  aria-label="Sign out of administrator workspace"
                  onSelect={() => void signOut()}
                  variant="destructive"
                >
                  <LogOutIcon aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        {/* Which release is actually serving this page.
            
            Read from the image tag at build time, not from package.json, whose
            version is a scaffolded 0.1.0 nobody maintains. Reporting a number
            that does not move is worse than reporting none: it invites somebody
            to conclude a deploy landed when it did not.
            
            Hidden when collapsed to icons — the rail has no room for it, and it
            is reference information rather than navigation. */}
        <p className="text-muted-foreground px-2 pb-1 font-mono text-[10.5px] tabular-nums group-data-[collapsible=icon]:hidden">
          {APP_VERSION_LABEL}
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
