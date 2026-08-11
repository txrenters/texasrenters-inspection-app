'use client';

import {
  ChevronRightIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  SettingsIcon,
  UserRoundIcon,
} from 'lucide-react';
import Image from 'next/image';
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
import { initials } from '@/lib/format';
import { cn } from '@/lib/utils';

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
  isActive,
  item,
  onNavigate,
}: {
  activeChild: AdminNavigationChild | undefined;
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
        isActive={isActive}
        onClick={toggle}
        tooltip={item.title}
      >
        <Icon aria-hidden />
        <span>{item.title}</span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            'ml-auto transition-transform duration-200 group-data-[collapsible=icon]:hidden',
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
                <SidebarMenuSubButton asChild isActive={childActive}>
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
  groups,
  onNavigate,
}: {
  activeType: string | null;
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
                          <Icon aria-hidden />
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

function NavigationTreeWithActiveType(props: { groups: AdminNavigationGroup[]; onNavigate: () => void }) {
  const activeType = useSearchParams().get('type');
  return <NavigationTree {...props} activeType={activeType} />;
}

export function AppSidebar() {
  const router = useRouter();
  const auth = useAuth();
  const { has } = usePermissions();
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = getVisibleAdminNavigation(has);
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
      <SidebarHeader className="h-14 justify-center border-b px-3">
        <Link
          aria-label="TexasRenters Inspection Admin — go to dashboard"
          className="focus-visible:ring-sidebar-ring flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2"
          href="/dashboard"
          onClick={closeMobileNavigation}
        >
          {/* The sidebar is a light surface here rather than the old navy bar, so
              the wordmark needs no brightness lift or drop shadow to separate
              from it — it sits on the same near-white it was designed for. */}
          <Image
            alt="TexasRenters"
            className="h-6 w-auto shrink-0 dark:brightness-0 dark:invert"
            height={167}
            priority
            src="/texasrenterslogo-transparent.png"
            width={600}
          />
          <span className="border-sidebar-border text-muted-foreground truncate border-l pl-2.5 text-xs font-medium tracking-wide uppercase group-data-[collapsible=icon]:hidden">
            Inspection
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 py-3">
        <Suspense
          fallback={
            <NavigationTree activeType={null} groups={groups} onNavigate={closeMobileNavigation} />
          }
        >
          <NavigationTreeWithActiveType groups={groups} onNavigate={closeMobileNavigation} />
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
                  <Avatar className="size-8 rounded-md">
                    <AvatarFallback className="bg-primary text-primary-foreground rounded-md text-xs font-semibold">
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
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
