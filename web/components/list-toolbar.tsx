'use client';

import { SearchIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useSearchText } from '@/lib/use-search-text';
import { cn } from '@/lib/utils';

/**
 * Radix Select rejects an empty string as an item value, so the unfiltered row
 * carries a sentinel that is translated back to `''` at the boundary. Exported
 * because every filtered list needs the same one.
 */
export const ALL = '__all__';

/**
 * The controls above a list.
 *
 * Not a panel. The old app wrapped these in a bordered, tinted box that was
 * visually heavier than the table it filtered — the eye landed on the filters
 * first and the data second. This is a plain row, and the only persistent
 * chrome is the search field.
 *
 * Active filters appear underneath as removable chips, so what is currently
 * narrowing the list is legible without opening each dropdown to check. That is
 * also the fix for the old app's real failure mode: an empty table with no
 * indication that a status filter from ten minutes ago was still applied.
 */
export function ListToolbar({
  search,
  onSearch,
  searchPlaceholder = 'Search…',
  searchLabel = 'Search',
  pending,
  resultLabel,
  filters,
  activeFilters,
  onClear,
  children,
}: {
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder?: string;
  searchLabel?: string;
  /** True while the debounced query has not caught up with the input. */
  pending?: boolean;
  resultLabel: string;
  filters?: ReactNode;
  activeFilters?: Array<{ label: string; value: string; onRemove: () => void }>;
  onClear?: () => void;
  children?: ReactNode;
}) {
  const [text, setText] = useSearchText(search, onSearch);
  const hasActive = Boolean(activeFilters?.length);
  return (
    <div className="space-y-3 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            aria-label={searchLabel}
            className="pl-9"
            onChange={(event) => setText(event.target.value)}
            placeholder={searchPlaceholder}
            type="search"
            value={text}
          />
          {pending ? (
            <Spinner className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2" />
          ) : null}
        </div>
        {filters}
        {children}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground mr-auto text-sm" aria-live="polite">
          {resultLabel}
        </p>
        {activeFilters?.map((filter) => (
          <Badge key={`${filter.label}-${filter.value}`} variant="secondary" className="gap-1 pr-1">
            <span className="text-muted-foreground">{filter.label}:</span>
            {filter.value}
            <button
              aria-label={`Remove ${filter.label} filter`}
              className="hover:bg-background/80 -mr-0.5 rounded-sm p-0.5 transition-colors"
              onClick={filter.onRemove}
              type="button"
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
        {hasActive && onClear ? (
          <Button onClick={onClear} size="sm" type="button" variant="ghost">
            Clear all
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A dropdown filter with a built-in "all" option.
 *
 * Every list page in the old app repeated the same twenty lines — a Field, a
 * Label, a Select, and the sentinel translation — once per filter.
 */
export function SelectFilter({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  allLabel?: string;
  className?: string;
}) {
  const everything = allLabel ?? `All ${label.toLowerCase()}`;
  return (
    <Select onValueChange={(next) => onChange(next === ALL ? '' : next)} value={value || ALL}>
      <SelectTrigger aria-label={label} className={cn('w-[168px]', className)} size="default">
        <SelectValue placeholder={everything} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{everything}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** `['SCHEDULED', …]` → select options with humanised labels. */
export function enumOptions(values: readonly string[]) {
  return values.map((value) => ({
    value,
    label: value
      .replaceAll('_', ' ')
      .toLowerCase()
      .replace(/^./, (character) => character.toUpperCase()),
  }));
}
