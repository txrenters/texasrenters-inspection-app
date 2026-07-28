'use client';

import {
  ChevronsUpDown,
  LogOut,
  Settings,
  Star,
  UserRound,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

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
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  getVisibleAdminNavigation,
  isAdminNavigationItemActive,
} from '@/lib/admin-navigation';
import { useAuth, usePermissions } from '@/lib/auth';

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function AppSidebar() {
  const pathname = usePathname();
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
      <SidebarHeader className="border-b border-sidebar-border/60 pb-2">
        {/* Brand only — no menu. Both destinations this dropdown offered
            (dashboard, settings) are already reachable from the nav tree and the
            account menu, so the disclosure chevron promised choices that were
            duplicates. */}
        <Link
          aria-label="TexasRenters Inspection Admin — go to dashboard"
          className="group/brand block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          href="/dashboard"
          onClick={closeMobileNavigation}
        >
          {/* No background plate, by preference. The wordmark's dark-blue "TEXAS"
              measures 1.33:1 against the navy sidebar, so a brightness lift plus a
              soft light drop-shadow separates it from the bar without a solid
              backdrop or recolouring the mark. */}
          <span className="hidden flex-col items-center gap-1 pt-1 pb-3 group-data-[state=expanded]:flex">
            <Image
              alt="TexasRenters"
              className="h-9 w-auto brightness-110 drop-shadow-[0_1px_3px_rgba(255,255,255,0.35)] transition-[filter] group-hover/brand:brightness-125"
              height={167}
              priority
              src="/texasrenterslogo-transparent.png"
              width={600}
            />
            {/* Sits directly under the wordmark and centred on it, so the two read
                as one "TexasRenters Inspection" lockup rather than a logo with a
                caption. Full white, matching the ".com" weight above it. */}
            <span className="text-[15px] font-semibold tracking-[0.14em] text-white uppercase">
              Inspection
            </span>
          </span>
          {/* Collapsed rail: a wide wordmark cannot shrink to a square. */}
          <span className="hidden aspect-square size-8 items-center justify-center group-data-[collapsible=icon]:flex">
            <Star aria-hidden className="size-5 fill-[#85c43f] text-[#85c43f]" />
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-5 px-2 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {groups.map((group) => (
          <SidebarGroup key={group.title} className="gap-2 p-0">
            <SidebarGroupLabel>{group.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="m-0 list-none p-0">
                {group.items.map((item) => {
                  const active = isAdminNavigationItemActive(pathname, item.href);
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.title}
                      >
                        <Link
                          aria-current={active ? 'page' : undefined}
                          href={item.href}
                          onClick={closeMobileNavigation}
                        >
                          <Icon aria-hidden />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu className="m-0 list-none p-0">
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  aria-label="Open account menu"
                  className="border-0 bg-transparent data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  size="lg"
                  tooltip="Account menu"
                >
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
                      {initials(displayName)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">{displayName}</span>
                    <span className="truncate text-xs">{accessLabel}</span>
                  </span>
                  <ChevronsUpDown aria-hidden className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-56"
                side={isMobile ? 'bottom' : 'right'}
                sideOffset={8}
              >
                <DropdownMenuLabel>
                  <span className="block truncate text-foreground">{displayName}</span>
                  <span className="block font-normal capitalize text-muted-foreground">
                    {accessLabel}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/profile" onClick={closeMobileNavigation}>
                    <UserRound aria-hidden />
                    Profile
                  </Link>
                </DropdownMenuItem>
                {has('integrations:read') ? (
                  <DropdownMenuItem asChild>
                    <Link href="/settings" onClick={closeMobileNavigation}>
                      <Settings aria-hidden />
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
                  <LogOut aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail className="border-0 bg-transparent" />
    </Sidebar>
  );
}
