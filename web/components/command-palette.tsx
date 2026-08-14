'use client';

import { LogOutIcon, MonitorIcon, MoonIcon, SearchIcon, SunIcon, UserRoundIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { getVisibleAdminNavigation } from '@/lib/admin-navigation';
import { useAuth, usePermissions } from '@/lib/auth';

/**
 * Jump to anything with ⌘K.
 *
 * New in this app. `cmdk` was already a dependency of the old one but only ever
 * powered the inside of a single searchable dropdown; the navigation itself was
 * mouse-only, which on a nine-section sidebar means every move between screens
 * is a hunt. This puts every permitted destination one keystroke away, and is
 * the only navigation surface that also works while the sidebar is collapsed to
 * icons.
 *
 * The list is built from the same permission-filtered navigation the sidebar
 * uses, so it can never offer a page the account cannot open.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const auth = useAuth();
  const { has } = usePermissions();
  const { setTheme } = useTheme();
  const groups = getVisibleAdminNavigation(has);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const run = useCallback((action: () => void) => {
    setOpen(false);
    action();
  }, []);

  return (
    <>
      <Button
        className="text-muted-foreground w-full justify-start gap-2 sm:w-56"
        onClick={() => setOpen(true)}
        size="sm"
        variant="outline"
      >
        <SearchIcon />
        <span className="truncate">Search…</span>
        <CommandShortcut className="hidden sm:inline">⌘K</CommandShortcut>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search"
        description="Jump to a page or run a command"
      >
        <CommandInput placeholder="Jump to a page or run a command…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup heading={group.title} key={group.title}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.href}
                    // Included so "inspections" matches the Inspections item
                    // even when the visible label has been reworded.
                    value={`${group.title} ${item.title} ${item.href}`}
                    onSelect={() => run(() => router.push(item.href))}
                  >
                    <Icon />
                    {item.title}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}

          <CommandSeparator />
          <CommandGroup heading="Account">
            <CommandItem value="profile account" onSelect={() => run(() => router.push('/profile'))}>
              <UserRoundIcon />
              Profile
            </CommandItem>
            <CommandItem
              value="sign out log out"
              onSelect={() => run(() => void auth.signOut().then(() => router.replace('/login')))}
            >
              <LogOutIcon />
              Sign out
            </CommandItem>
          </CommandGroup>

          <CommandGroup heading="Theme">
            <CommandItem value="light theme" onSelect={() => run(() => setTheme('light'))}>
              <SunIcon />
              Light
            </CommandItem>
            <CommandItem value="dark theme" onSelect={() => run(() => setTheme('dark'))}>
              <MoonIcon />
              Dark
            </CommandItem>
            <CommandItem value="system theme" onSelect={() => run(() => setTheme('system'))}>
              <MonitorIcon />
              System
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
