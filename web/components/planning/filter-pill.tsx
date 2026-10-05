'use client';

import { CheckIcon } from 'lucide-react';
import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
  /** A dot before the label, in this class's colour: a technician's on the calendar. */
  swatch?: string;
  /** A second, quieter line: "23 days · 207 visits". */
  detail?: string;
}

/**
 * A filter as Jobber's schedule draws one (the office, 2026-10-05): "Team | All"
 * on a pill, opening a checklist with how many are ticked, Clear and Select all.
 *
 * Held as what is hidden, so a new technician or kind of visit shows until
 * somebody unticks it.
 */
export function FilterPill({
  label,
  options,
  hidden,
  onChange,
}: {
  label: string;
  options: readonly FilterOption[];
  hidden: ReadonlySet<string>;
  onChange: (hidden: ReadonlySet<string>) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = options.filter((option) => !hidden.has(option.value));
  const filtering = shown.length !== options.length;
  const summary = !filtering ? 'All' : shown.length ? shown.map((option) => option.label).join(', ') : 'None';
  const needle = query.trim().toLowerCase();
  const listed = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;

  const toggle = (value: string) => {
    const next = new Set(hidden);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <Popover onOpenChange={(open) => !open && setQuery('')}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${label}: ${summary}`}
          className={cn(
            'hover:bg-accent focus-visible:ring-ring/50 inline-flex h-8 max-w-72 min-w-0 items-center gap-2 rounded-full border px-3 text-sm outline-none focus-visible:ring-[3px]',
            filtering && 'bg-accent',
          )}
          type="button"
        >
          <span className="shrink-0 font-medium">{label}</span>
          <span aria-hidden className="bg-border h-4 w-px shrink-0" />
          <span className="text-muted-foreground truncate">{summary}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        {options.length > 6 ? (
          <div className="border-b p-2">
            <Input
              aria-label={`Search ${label.toLowerCase()}`}
              className="h-8"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              value={query}
            />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 text-sm">
          <span className="font-medium">{shown.length.toLocaleString()} selected</span>
          <button
            className="text-primary text-xs font-medium underline-offset-4 hover:underline disabled:opacity-50"
            disabled={!shown.length}
            onClick={() => onChange(new Set(options.map((option) => option.value)))}
            type="button"
          >
            Clear
          </button>
        </div>
        <div aria-label={label} className="max-h-72 overflow-y-auto pb-1" role="group">
          {listed.map((option) => {
            const checked = !hidden.has(option.value);
            return (
              <button
                aria-checked={checked}
                className="hover:bg-accent flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm"
                key={option.value}
                onClick={() => toggle(option.value)}
                role="checkbox"
                type="button"
              >
                {option.swatch ? <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', option.swatch)} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.detail ? (
                    <span className="text-muted-foreground block truncate font-mono text-xs tabular-nums">{option.detail}</span>
                  ) : null}
                </span>
                <CheckIcon aria-hidden className={cn('size-4 shrink-0', checked ? 'text-foreground' : 'invisible')} />
              </button>
            );
          })}
          {!listed.length ? <p className="text-muted-foreground px-3 py-2 text-sm">Nothing matches.</p> : null}
        </div>
        {filtering ? (
          <div className="border-t px-3 py-2">
            <button
              className="text-primary text-xs font-medium underline-offset-4 hover:underline"
              onClick={() => onChange(new Set())}
              type="button"
            >
              Select all
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
