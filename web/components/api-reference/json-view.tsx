'use client';

import { CheckIcon, ChevronRightIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Nodes below this depth start collapsed.
 *
 * Two levels is where an inspection response stops being an overview and becomes
 * a wall — the top level names the fields, the second shows the shape of each,
 * and the third is forty photo records nobody opened the page to read.
 */
const AUTO_COLLAPSE_DEPTH = 2;

/** Arrays longer than this render a head and a count rather than every element. */
const PREVIEW_LIMIT = 100;

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === 'string')
    return <span className="text-success break-all">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="text-primary tabular-nums">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-warning">{String(value)}</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function Branch({ value, depth, label }: { value: Json; depth: number; label?: string }) {
  const [open, setOpen] = useState(depth < AUTO_COLLAPSE_DEPTH);

  if (!isRecord(value) && !Array.isArray(value))
    return (
      <div className="flex gap-1.5">
        {label ? <span className="text-muted-foreground shrink-0">{label}:</span> : null}
        <Scalar value={value} />
      </div>
    );

  const entries: Array<[string, Json]> = Array.isArray(value)
    ? value.slice(0, PREVIEW_LIMIT).map((item, index) => [String(index), item])
    : Object.entries(value);
  const hidden = Array.isArray(value) ? Math.max(0, value.length - PREVIEW_LIMIT) : 0;
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  const bounds = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <div>
      <button
        aria-expanded={open}
        className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded outline-none focus-visible:ring-2"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
        {label ? <span className="text-muted-foreground">{label}:</span> : null}
        <span className="text-muted-foreground">
          {bounds[0]}
          {open ? '' : ` ${count} ${count === 1 ? 'entry' : 'entries'} `}
          {open ? '' : bounds[1]}
        </span>
      </button>
      {open ? (
        <div className="border-border/60 ml-1.5 border-l pl-3">
          {entries.map(([key, child]) => (
            <Branch depth={depth + 1} key={key} label={key} value={child} />
          ))}
          {hidden > 0 ? (
            <p className="text-muted-foreground italic">
              …{hidden} more {hidden === 1 ? 'element' : 'elements'} not shown
            </p>
          ) : null}
          <span className="text-muted-foreground">{bounds[1]}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A JSON response, readable.
 *
 * A collapsible tree rather than a syntax-highlighted blob, because the thing
 * an operator is doing here is answering "did this field come back, and what is
 * in it" against a payload that can run to thousands of lines. Copy hands over
 * the whole document regardless of what is collapsed — what is on screen is a
 * reading aid, not the data.
 */
export function JsonView({ value, className }: { value: Json; className?: string }) {
  const [copied, setCopied] = useState(false);
  const serialized = JSON.stringify(value, null, 2) ?? 'undefined';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(serialized);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access is denied in some embedded contexts. The text is still
      // selectable, so failing silently is better than an error nobody can act on.
    }
  };

  return (
    <div className={cn('bg-muted/40 relative rounded-md border', className)}>
      <Button
        aria-label="Copy JSON"
        className="absolute top-1.5 right-1.5 z-10"
        onClick={() => void copy()}
        size="sm"
        variant="ghost"
      >
        {copied ? <CheckIcon aria-hidden className="text-success" /> : <CopyIcon aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {/* Wide payloads scroll inside this box rather than widening the page. */}
      <div className="max-h-[28rem] overflow-auto p-3 pr-20 font-mono text-xs leading-relaxed">
        <Branch depth={0} value={value} />
      </div>
    </div>
  );
}
