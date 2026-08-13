'use client';

import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type UIEvent } from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type SearchableSelectOption = {
  value: string;
  label: string;
  searchText?: string;
};

/**
 * Combobox, built on the shadcn Popover + Command pair.
 *
 * A trigger button plus a popover-owned search field, rather than one `<input>`
 * serving as both the selected-value display and the search box. Command
 * supplies the roving focus, type-ahead and Escape handling.
 *
 * Filtering stays server-driven when `onSearch` is supplied: Command's built-in
 * matcher is switched off in that case so it cannot hide rows the server just
 * returned.
 */
export function SearchableSelect({
  id,
  value,
  options,
  placeholder,
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matching options.',
  clearLabel,
  disabled = false,
  hasMore = false,
  loadingMore = false,
  selectedOption,
  optionsLabel = 'Options',
  loadingMoreLabel = 'Loading more options…',
  moreHint = 'Scroll for more options',
  className,
  onChange,
  onSearch,
  onLoadMore,
}: {
  id: string;
  value: string;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  clearLabel?: string;
  disabled?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  selectedOption?: SearchableSelectOption;
  optionsLabel?: string;
  loadingMoreLabel?: string;
  moreHint?: string;
  className?: string;
  onChange: (value: string) => void;
  onSearch?: (query: string) => void;
  onLoadMore?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCache, setSelectedCache] = useState<SearchableSelectOption>();

  const availableOptions = useMemo(
    () => (clearLabel ? [{ value: '', label: clearLabel }, ...options] : options),
    [clearLabel, options],
  );
  const selected =
    availableOptions.find((option) => option.value === value) ??
    (selectedCache?.value === value ? selectedCache : undefined) ??
    (selectedOption?.value === value ? selectedOption : undefined);

  // Remember the chosen option: a server-driven search can drop it out of
  // `options` on the next keystroke, and the trigger still has to show its label.
  useEffect(() => {
    const match = availableOptions.find((option) => option.value === value);
    if (match) setSelectedCache(match);
  }, [availableOptions, value]);

  const searching = query.trim().length > 0;

  /**
   * The rows actually rendered.
   *
   * The chosen option is pinned to the top when the loaded page does not
   * contain it — with paginated or auto-filled values it usually will not, and
   * the list would then open with no checkmark anywhere, silently disagreeing
   * with the trigger above it.
   *
   * Not pinned while searching: a row that does not match what was typed is
   * noise, and the checkmark on the trigger still carries the current value.
   */
  const listOptions = useMemo(() => {
    if (searching || !selected) return availableOptions;
    return availableOptions.some((option) => option.value === selected.value)
      ? availableOptions
      : [selected, ...availableOptions];
  }, [availableOptions, searching, selected]);

  /** cmdk matches on the item's `value`, so this must be built identically. */
  const itemValue = (option: SearchableSelectOption) =>
    `${option.label} ${option.searchText ?? ''}`.trim();

  useEffect(() => {
    if (!open || !onSearch) return;
    const timer = window.setTimeout(() => onSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [open, onSearch, query]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Reset on close so reopening starts from the full list rather than the
    // last query's narrowed results.
    if (!next) {
      setQuery('');
      onSearch?.('');
    }
  }

  // Reads the scrolling element from the event rather than a ref: CommandList
  // owns its own inner sizer, so a forwarded ref does not reliably land on the
  // node that actually scrolls.
  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || loadingMore || !onLoadMore) return;
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 24) onLoadMore();
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          className={cn(
            'border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none',
            'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            'dark:bg-input/30 dark:hover:bg-input/50 transition-[color,box-shadow]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            selected ? 'text-foreground' : 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
        >
          {/* min-w-0 is what makes `truncate` actually take effect: without it
              the flex item cannot shrink below its content width. */}
          <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDownIcon aria-hidden className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command defaultValue={selected ? itemValue(selected) : undefined} shouldFilter={!onSearch}>
          <CommandInput onValueChange={setQuery} placeholder={searchPlaceholder} value={query} />
          <CommandList onScroll={handleScroll}>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup heading={optionsLabel}>
              {listOptions.map((option) => (
                <CommandItem
                  key={option.value || '__clear__'}
                  onSelect={() => {
                    onChange(option.value);
                    handleOpenChange(false);
                  }}
                  value={itemValue(option)}
                >
                  <CheckIcon
                    aria-hidden
                    className={cn('size-4', option.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {loadingMore ? (
              <p className="text-muted-foreground px-3 py-2 text-xs" role="status">
                {loadingMoreLabel}
              </p>
            ) : hasMore ? (
              <p className="text-muted-foreground px-3 py-2 text-xs">{moreHint}</p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
