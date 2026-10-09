'use client';

import type { AdminInspection, AdminProperty, AdminTechnician } from '@texasrenters/shared';
import { useQuery } from '@tanstack/react-query';
import {
  Building2Icon,
  ClipboardCheckIcon,
  HardHatIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SunIcon,
  UserRoundIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { usePageSearch, type PageSearch } from '@/components/page-search';
import { Button } from '@/components/ui/button';
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
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { getVisibleAdminNavigation } from '@/lib/admin-navigation';
import { api, type Page, queryString } from '@/lib/api';
import { useAuth, usePermissions } from '@/lib/auth';
import { formatScheduledDate, humanize } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useSearchText } from '@/lib/use-search-text';

/** How many of each kind of record the search shows: enough to pick from. */
const RECORDS = 5;
/** Fewer letters than this match too much to be worth asking for. */
const MIN_QUERY = 2;

/**
 * Records matching what was typed: inspections, properties and technicians,
 * each only for an account allowed to read them.
 *
 * The office (2026-10-07): the header's search only jumped between pages, while
 * every list had a search box of its own. It now finds the records themselves,
 * from anywhere in the console -- the lists' searches live in the header too.
 */
function useRecordSearch(term: string, open: boolean) {
  const { has } = usePermissions();
  const ready = open && term.length >= MIN_QUERY;
  const query = { page: 1, pageSize: RECORDS, search: term };
  const inspections = useQuery({
    queryKey: ['admin', 'search', 'inspections', term],
    queryFn: ({ signal }) =>
      api<Page<AdminInspection>>(`/api/v1/admin/inspections${queryString(query)}`, { signal }),
    enabled: ready && has('inspections:read'),
    staleTime: 30_000,
  });
  const properties = useQuery({
    queryKey: ['admin', 'search', 'properties', term],
    queryFn: ({ signal }) =>
      api<Page<AdminProperty>>(`/api/v1/admin/properties${queryString(query)}`, { signal }),
    enabled: ready && has('properties:read'),
    staleTime: 30_000,
  });
  const technicians = useQuery({
    queryKey: ['admin', 'search', 'technicians', term],
    queryFn: ({ signal }) =>
      api<Page<AdminTechnician>>(`/api/v1/admin/technicians${queryString(query)}`, { signal }),
    enabled: ready && has('technicians:read'),
    staleTime: 30_000,
  });
  return {
    ready,
    searching: inspections.isFetching || properties.isFetching || technicians.isFetching,
    inspections: ready ? (inspections.data?.items ?? []) : [],
    properties: ready ? (properties.data?.items ?? []) : [],
    technicians: ready ? (technicians.data?.items ?? []) : [],
  };
}

/** Every word of the query somewhere in the text, as the lists' search reads it. */
function matchesWords(text: string, query: string) {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** True on a Mac, iPhone or iPad: the keyboards with a Command key. */
function isApplePlatform() {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '');
}

const NEVER_CHANGES = () => () => {};

/**
 * The shortcut as this keyboard spells it (console-development): "⌘K" was
 * printed on Windows, where the office presses Ctrl K. The server and the
 * first paint say "Ctrl K" -- most of the office is on Windows -- and a Mac
 * corrects it once hydrated, without a mismatch warning.
 */
function useShortcutLabel() {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => (isApplePlatform() ? '⌘K' : 'Ctrl K'),
    () => 'Ctrl K',
  );
}

/**
 * A list page's search, in the header (`page-search`). Typing narrows the list
 * underneath; the shortcut beside it still searches everything.
 */
function HeaderListSearch({
  search,
  onSearchEverything,
  shortcut,
}: {
  search: PageSearch;
  onSearchEverything: () => void;
  shortcut: string;
}) {
  const [text, setText] = useSearchText(search.value, search.onChange);
  return (
    <div className="relative w-full sm:w-72">
      <SearchIcon
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
      />
      <Input
        aria-label={search.label}
        className="h-8 pr-20 pl-8"
        onChange={(event) => setText(event.target.value)}
        placeholder={search.placeholder}
        type="search"
        value={text}
      />
      {search.pending ? (
        <Spinner className="text-muted-foreground absolute top-1/2 right-15 size-3.5 -translate-y-1/2" />
      ) : null}
      <button
        aria-label="Search everything"
        className="text-muted-foreground hover:bg-muted absolute top-1/2 right-1.5 -translate-y-1/2 rounded border px-1.5 py-0.5 text-[10px] font-medium"
        onClick={onSearchEverything}
        title="Search inspections, properties, technicians and pages"
        type="button"
      >
        {shortcut}
      </button>
    </div>
  );
}

/**
 * The header's search.
 *
 * On a list page it is that list's search. Everywhere, Ctrl K (⌘K) finds inspections,
 * properties and technicians by what was typed, and every page the account can
 * open -- the same permission-filtered navigation the sidebar draws.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const term = useDebouncedValue(query.trim(), 250);
  const router = useRouter();
  const auth = useAuth();
  const { has } = usePermissions();
  const { setTheme } = useTheme();
  const pageSearch = usePageSearch();
  const groups = getVisibleAdminNavigation(has);
  const records = useRecordSearch(term, open);
  const shortcut = useShortcutLabel();

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

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  const run = useCallback(
    (action: () => void) => {
      changeOpen(false);
      action();
    },
    [changeOpen],
  );

  // "Nothing matches" waits for the answer: until the typing settles and the
  // records arrive, an empty list means "not yet", not "no".
  const settling =
    query.trim().length >= MIN_QUERY && (query.trim() !== term || records.searching);
  const pages = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => matchesWords(`${group.title} ${item.title} ${item.href}`, query)),
    }))
    .filter((group) => group.items.length);

  // Matched like the pages (console-development): these vanished the moment
  // anything was typed, so "sign out" or "dark" found nothing.
  const account = [
    {
      value: 'profile account',
      words: 'Account profile',
      label: 'Profile',
      icon: UserRoundIcon,
      action: () => router.push('/profile'),
    },
    {
      value: 'sign out log out',
      words: 'Account sign out log out',
      label: 'Sign out',
      icon: LogOutIcon,
      action: () => void auth.signOut().then(() => router.replace('/login')),
    },
  ].filter((command) => matchesWords(command.words, query));
  const themes = [
    { value: 'light theme', label: 'Light', icon: SunIcon, theme: 'light' },
    { value: 'dark theme', label: 'Dark', icon: MoonIcon, theme: 'dark' },
    { value: 'system theme', label: 'System', icon: MonitorIcon, theme: 'system' },
  ].filter((command) => matchesWords(`Theme ${command.value}`, query));

  return (
    <>
      {pageSearch ? (
        <HeaderListSearch
          onSearchEverything={() => setOpen(true)}
          search={pageSearch}
          shortcut={shortcut}
        />
      ) : (
        <Button
          className="text-muted-foreground w-full justify-start gap-2 sm:w-56"
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          <SearchIcon />
          <span className="truncate">Search…</span>
          <CommandShortcut className="hidden sm:inline">{shortcut}</CommandShortcut>
        </Button>
      )}

      {/* Not filtered by cmdk: the records are the server's answer already,
          and the pages are matched word by word above, as the lists are. */}
      <CommandDialog
        description="Find an inspection, property, technician or page"
        onOpenChange={changeOpen}
        open={open}
        shouldFilter={false}
        title="Search"
      >
        <CommandInput
          onValueChange={setQuery}
          placeholder="Search inspections, properties, technicians, pages…"
          value={query}
        />
        <CommandList>
          {settling ? (
            <div className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-sm" role="status">
              <Spinner className="size-4" />
              Searching…
            </div>
          ) : (
            <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
          )}

          {records.inspections.length ? (
            <CommandGroup heading="Inspections">
              {records.inspections.map((inspection) => {
                const technician = (inspection.assignments ?? []).find((entry) => entry.isCurrent)
                  ?.technician?.displayName;
                return (
                  <CommandItem
                    key={inspection.id}
                    onSelect={() => run(() => router.push(`/inspections/${inspection.id}`))}
                    value={`inspection-${inspection.id}`}
                  >
                    <ClipboardCheckIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {inspection.propertywareBuilding?.name ?? 'Property snapshot'}
                        {inspection.propertywareUnit?.name ? ` · ${inspection.propertywareUnit.name}` : ''}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {humanize(inspection.inspectionType)} · {formatScheduledDate(inspection.scheduledAt)} ·{' '}
                        {technician ?? 'Unassigned'}
                      </span>
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {records.properties.length ? (
            <CommandGroup heading="Properties">
              {records.properties.map((property) => (
                <CommandItem
                  key={property.id}
                  onSelect={() => run(() => router.push(`/properties/${property.id}`))}
                  value={`property-${property.id}`}
                >
                  <Building2Icon />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{property.name}</span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {[property.addressLine1, property.city].filter(Boolean).join(', ')}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {records.technicians.length ? (
            <CommandGroup heading="Technicians">
              {records.technicians.map((technician) => (
                <CommandItem
                  key={technician.id}
                  onSelect={() => run(() => router.push(`/technicians/${technician.id}`))}
                  value={`technician-${technician.id}`}
                >
                  <HardHatIcon />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{technician.displayName}</span>
                    <span className="text-muted-foreground block truncate text-xs">{technician.email}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {pages.map((group) => (
            <CommandGroup heading={group.title} key={group.title}>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.href}
                    onSelect={() => run(() => router.push(item.href))}
                    value={`page-${item.href}`}
                  >
                    <Icon />
                    {item.title}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}

          {account.length || themes.length ? <CommandSeparator /> : null}
          {account.length ? (
            <CommandGroup heading="Account">
              {account.map((command) => {
                const Icon = command.icon;
                return (
                  <CommandItem key={command.value} onSelect={() => run(command.action)} value={command.value}>
                    <Icon />
                    {command.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {themes.length ? (
            <CommandGroup heading="Theme">
              {themes.map((command) => {
                const Icon = command.icon;
                return (
                  <CommandItem
                    key={command.value}
                    onSelect={() => run(() => setTheme(command.theme))}
                    value={command.value}
                  >
                    <Icon />
                    {command.label}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}
