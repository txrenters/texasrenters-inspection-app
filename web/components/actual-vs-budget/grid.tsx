'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Table, TableCell, TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The spreadsheet cells Actual vs Budget's sheets are made of (2026-11-17; the
 * office: "design it like a csv that there's an actual cell we can add entry
 * on", and "cell should be auto adjust also").
 */

/** A sheet: as wide as its cells, scrolling sideways inside its own border. */
export function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table className="w-max min-w-full border-collapse text-xs">{children}</Table>
    </div>
  );
}

/** A column heading. It wraps, so a column is as wide as what is typed in it, not as its name. */
export function SheetHead({ children, numeric, span, className }: { children?: ReactNode; numeric?: boolean; span?: number; className?: string }) {
  return (
    <TableHead
      className={cn('h-auto border-r px-2 py-2 align-bottom text-xs leading-tight font-semibold whitespace-normal', numeric && 'text-right', className)}
      colSpan={span}
      scope="col"
    >
      <div className={cn(span ? '' : 'max-w-[7.5rem]', numeric && 'ml-auto')}>{children}</div>
    </TableHead>
  );
}

export function TotalCell({ children, numeric, span }: { children?: ReactNode; numeric?: boolean; span?: number }) {
  return (
    <TableCell className={cn('border-r px-2 py-1.5 whitespace-nowrap', numeric && 'text-right font-mono tabular-nums')} colSpan={span}>
      {children}
    </TableCell>
  );
}

// ── A cell ──────────────────────────────────────────────────────────────────

/**
 * A spreadsheet cell: it grows with what is in it, saves when it is left or on
 * Enter, and goes back to what it was on Escape.
 */
export function GridCell({
  text,
  label,
  title,
  numeric,
  wide,
  readOnly,
  onCommit,
  onChange,
}: {
  text: string;
  label: string;
  title?: string;
  numeric?: boolean;
  wide?: boolean;
  readOnly?: boolean;
  /** Saves; false keeps what was typed out of the cell. Absent for a cell whose row saves it. */
  onCommit?: (typed: string) => Promise<boolean> | boolean;
  onChange?: (typed: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [focused, setFocused] = useState(false);
  const [settled, setSettled] = useState(0);
  // What the cell shows follows the row whenever nobody is typing in it.
  useEffect(() => {
    if (!focused) setDraft(text);
  }, [text, focused, settled]);
  const ref = useRef<HTMLTextAreaElement>(null);

  const leave = async () => {
    setFocused(false);
    if (!onCommit || draft === text) return;
    const kept = await onCommit(draft);
    if (!kept) setDraft(text);
    setSettled((count) => count + 1);
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ref.current?.blur();
    }
    if (event.key === 'Escape') {
      setDraft(text);
      setTimeout(() => ref.current?.blur());
    }
  };
  return (
    <TableCell className="border-r p-0 align-top" title={title}>
      <textarea
        aria-label={label}
        className={cn(
          'block min-h-8 min-w-[max(100%,5.5rem)] resize-none bg-transparent px-2 py-1.5 leading-snug outline-none [field-sizing:content]',
          'focus:bg-background focus:ring-ring focus:ring-2 focus:ring-inset',
          numeric && 'text-right font-mono tabular-nums',
          wide ? 'min-w-56 max-w-[22rem]' : 'max-w-[14rem]',
          readOnly && 'text-muted-foreground cursor-default',
        )}
        onBlur={() => void leave()}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange?.(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={key}
        readOnly={readOnly}
        ref={ref}
        rows={1}
        spellCheck={false}
        value={draft}
      />
    </TableCell>
  );
}
