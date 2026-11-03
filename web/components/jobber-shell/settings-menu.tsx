'use client';

import { LogOutIcon, PanelLeftIcon, SettingsIcon, SlidersHorizontalIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment } from 'react';

import { useSwitchConsoleShell } from '@/components/console-shell-context';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { APP_VERSION_LABEL } from '@/lib/app-version';
import { useAuth, usePermissions } from '@/lib/auth';
import { getJobberNavigation } from '@/lib/jobber-navigation';

/**
 * The gear, where Jobber keeps everything that is not the day's work: the
 * account, the team, the connected apps. Here: profile and settings, then the
 * administration pages the classic sidebar lists under Admin, IT tools and
 * Integrations -- the same pages behind the same permissions -- then the way
 * back to the classic layout, and sign out.
 */
export function JobberSettingsMenu() {
  const auth = useAuth();
  const router = useRouter();
  const { has } = usePermissions();
  const switchShell = useSwitchConsoleShell();
  const { settings } = getJobberNavigation(has);
  const displayName = auth.profile?.displayName ?? 'Administrator';

  const signOut = async () => {
    await auth.signOut();
    router.replace('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="Settings and account" size="icon" variant="ghost">
          <SettingsIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[calc(100dvh-5rem)] w-64 overflow-y-auto" sideOffset={8}>
        <DropdownMenuLabel className="font-normal">
          <span className="text-heading block truncate font-semibold">{displayName}</span>
          {auth.profile?.email ? (
            <span className="text-muted-foreground block truncate text-xs">{auth.profile.email}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <UserRoundIcon aria-hidden />
            Profile
          </Link>
        </DropdownMenuItem>
        {has('integrations:read') ? (
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <SlidersHorizontalIcon aria-hidden />
              Settings
            </Link>
          </DropdownMenuItem>
        ) : null}

        {settings.map((section) => (
          <Fragment key={section.title}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup aria-label={section.title}>
              <DropdownMenuLabel className="text-muted-foreground py-1 text-xs font-medium">
                {section.title}
              </DropdownMenuLabel>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem asChild key={item.href}>
                    <Link href={item.href}>
                      <Icon aria-hidden />
                      {item.title}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </Fragment>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => switchShell('classic')}>
          <PanelLeftIcon aria-hidden />
          Classic layout
        </DropdownMenuItem>
        <DropdownMenuItem
          aria-label="Sign out of administrator workspace"
          onSelect={() => void signOut()}
          variant="destructive"
        >
          <LogOutIcon aria-hidden />
          Sign out
        </DropdownMenuItem>
        {/* Which release is serving this page, as the classic sidebar's foot says. */}
        <p className="text-muted-foreground px-2 pt-1 pb-1.5 font-mono text-[10.5px] tabular-nums">
          {APP_VERSION_LABEL}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
