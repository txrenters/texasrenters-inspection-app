'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { Table, TableCell, TableHead } from '@/components/ui/table';
import { editorColour, initials, useActualVsBudgetLive } from '@/lib/actual-vs-budget-live';
import { cellTextOf, focusTarget, moveFrom, type Move } from '@/lib/sheet-navigation';
import { cn } from '@/lib/utils';

import { useSheetKeys } from './sheet-keys';

/**
 * The spreadsheet cells Actual vs Budget's sheets are made of (2026-11-17; the
 * office: "design it like a csv that there's an actual cell we can add entry
 * on", and "cell should be auto adjust also").
 */

/** Room left under a sheet: the page's bottom padding. */
const SHEET_BOTTOM_GAP = 20;
/** A sheet is never squeezed shorter than this, on a short screen. */
const SHEET_MIN_HEIGHT = 320;

/**
 * A sheet: as wide as its cells, in a box that fits the screen from where it
 * starts (2026-11-17, the office: "the horizontal scrollbar make it fixed and
 * the header part too make it sticky"). Its rows scroll inside it, so its
 * column headings stay on top and its sideways scrollbar stays at the bottom
 * of the screen, always in reach. A sheet shorter than the screen is as tall
 * as its rows.
 */
export function Sheet({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const fit = () => {
      const element = box.current;
      if (!element) return;
      // From where the sheet starts on the page, not where it is scrolled to: the box is as tall as the screen allows below its place.
      const top = element.getBoundingClientRect().top + window.scrollY;
      setMaxHeight(Math.max(SHEET_MIN_HEIGHT, window.innerHeight - top - SHEET_BOTTOM_GAP));
    };
    fit();
    window.addEventListener('resize', fit);
    // What is above the sheet can change height (a banner, a filter row): fit again when the page does.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    watch?.observe(document.body);
    return () => {
      window.removeEventListener('resize', fit);
      watch?.disconnect();
    };
  }, []);
  const keys = useSheetKeys();
  return (
    <div
      className={cn(
        'overflow-auto overscroll-x-contain rounded-md border',
        // The headings stick to the top of this box, over the rows; the table's own wrapper must not scroll too.
        '[&_[data-slot=table-container]]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-20 [&_thead]:shadow-[0_1px_0_var(--border)]',
        // A Total's cell, selected: outlined as a cell is.
        '[&_td:focus]:ring-ring [&_td:focus]:ring-2 [&_td:focus]:outline-none [&_td:focus]:ring-inset',
      )}
      data-slot="sheet"
      onCopy={(event) => copyCell(event)}
      onKeyDown={moveKey}
      onMouseDown={selectTotal}
      onPaste={(event) => pasteBlock(event, keys?.paste)}
      ref={box}
      style={{ maxHeight }}
    >
      <Table className="w-max min-w-full border-collapse text-xs">{children}</Table>
    </div>
  );
}

// ── The keyboard (2026-11-18, the office: "keyboard shortcuts also on the console spreadsheet") ──

/** A text box being typed in -- a cell being edited, the search box: the sheet's own keys leave it alone. */
const typingIn = (target: HTMLElement) => (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && !target.readOnly && !target.disabled;
/** A selected cell of the sheet's body: its text box (not being typed in), or a Total's cell itself. */
const selectedCell = (target: HTMLElement) => {
  if (typingIn(target) || target.closest('button, a, select, input')) return null;
  const cell = target.closest('td');
  return cell && cell.closest('tbody') ? cell : null;
};

const MOVES: Record<string, Move | undefined> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageUp', PageDown: 'pageDown' };

/** Arrows, Enter, Tab, Home, End and Page Up/Down move the selection, as in Excel. */
function moveKey(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (!selectedCell(target) || event.altKey) return;
  const mod = event.ctrlKey || event.metaKey;
  const move: Move | undefined =
    event.key === 'Enter'
      ? event.shiftKey
        ? 'up'
        : 'down'
      : event.key === 'Tab'
        ? event.shiftKey
          ? 'left'
          : 'right'
        : event.key === 'Home'
          ? mod
            ? 'first'
            : 'rowStart'
          : event.key === 'End'
            ? mod
              ? 'last'
              : 'rowEnd'
            : MOVES[event.key];
  if (!move) return;
  event.preventDefault();
  moveFrom(target, move);
}

/** A click on a Total's cell selects it, as on any other. */
function selectTotal(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (target.closest('textarea, button, a, input')) return;
  const cell = target.closest('td');
  if (cell?.closest('tbody')) focusTarget(cell);
}

/** Ctrl+C on a selected cell copies what it shows. */
function copyCell(event: ClipboardEvent<HTMLDivElement>) {
  const cell = selectedCell(event.target as HTMLElement);
  if (!cell) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', cellTextOf(cell).trim());
}

/** Ctrl+V on a selected cell: what was copied goes in from there, across and down -- a block from Excel too. */
function pasteBlock(event: ClipboardEvent<HTMLDivElement>, paste: ((from: HTMLTableCellElement, text: string) => Promise<void>) | undefined) {
  const cell = selectedCell(event.target as HTMLElement);
  if (!cell || !paste) return;
  event.preventDefault();
  void paste(cell, event.clipboardData.getData('text/plain'));
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
 * A spreadsheet cell, as Excel's (2026-11-18): a click selects it, and typing
 * in it -- or F2, or a double-click -- edits it; it saves on Enter, Tab, an
 * arrow (when typing over it) or when it is left, and goes back to what it was
 * on Escape. Delete clears it alone. It grows with what is in it. With a
 * `cell` name it is live (2026-11-17): the others see when this person is in
 * it, and this person sees the others' -- a coloured border and their
 * initials, as a shared workbook shows them -- and each save can be taken back
 * with Ctrl+Z.
 */
export function GridCell({
  cell,
  text,
  label,
  title,
  numeric,
  wide,
  readOnly,
  onCommit,
  onChange,
}: {
  /** The cell's name, as `revenueCell` makes it; none for a cell nobody else edits (a new row's). */
  cell?: string;
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
  // Selected, or being edited: typed over ('type': an arrow saves and moves) or edited in place ('edit': an arrow moves the caret).
  const [editing, setEditing] = useState<false | 'type' | 'edit'>(false);
  const [settled, setSettled] = useState(0);
  // What the cell shows follows the row whenever nobody is typing in it.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing, settled]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const live = useActualVsBudgetLive();
  const keys = useSheetKeys();
  const owner = cell ? live.cellOwners.get(cell) : undefined;
  const latest = useRef({ text, onCommit, onChange });
  latest.current = { text, onCommit, onChange };

  /** Saves what is typed as the cell's; `record` makes it a step Ctrl+Z takes back. */
  const save = useCallback(
    async (next: string, record: boolean) => {
      const { text: was, onCommit: commit, onChange: change } = latest.current;
      if (!commit) {
        setDraft(next);
        change?.(next);
        return true;
      }
      if (next === was) return true;
      setDraft(next);
      const kept = await commit(next);
      if (!kept) setDraft(latest.current.text);
      else if (record && cell) keys?.record([{ cell, before: was, after: next }]);
      setSettled((count) => count + 1);
      return kept;
    },
    [cell, keys],
  );
  const savable = Boolean(onCommit) && !readOnly;
  useEffect(() => {
    if (!cell || !keys || !savable) return;
    return keys.register(cell, { save: (next) => save(next, false), focus: () => ref.current?.focus() });
  }, [cell, keys, savable, save]);
  // Editing begins with the caret at the end of what is there.
  useEffect(() => {
    const box = ref.current;
    if (editing && box) box.setSelectionRange(box.value.length, box.value.length);
  }, [editing]);

  const edit = (mode: 'type' | 'edit', typed?: string) => {
    if (readOnly) return;
    if (typed !== undefined) {
      setDraft(typed);
      latest.current.onChange?.(typed);
    }
    setEditing(mode);
  };
  const leave = () => {
    if (cell) live.focusCell(null);
    setEditing(false);
    // What differs from the cell's is what was typed (or pasted) into it: saved.
    if (onCommit && draft !== text) void save(draft, true);
  };
  /** Done typing: the selection moves on, and leaving the cell saves it -- or, with nowhere to go, it is saved here. */
  const finish = (move: Move) => {
    const box = ref.current;
    if (!box) return;
    const next = moveFrom(box, move);
    if (!next || next === box) {
      setEditing(false);
      if (onCommit && draft !== text) void save(draft, true);
    }
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!editing) {
      // Selected: the sheet moves the selection; here, what begins or clears an edit.
      if (readOnly || event.altKey) return;
      if (event.key === 'F2') {
        event.preventDefault();
        edit('edit');
      } else if (event.key === 'Delete' && !mod) {
        event.preventDefault();
        void save('', true);
      } else if (event.key === 'Backspace' && !mod) {
        event.preventDefault();
        edit('type', '');
      } else if (event.key.length === 1 && !mod && event.key !== '?') {
        // Typing over the cell, as in Excel: what it held is replaced.
        event.preventDefault();
        edit('type', event.key);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(text);
      setEditing(false);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      finish('down');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      finish(event.shiftKey ? 'left' : 'right');
    } else if (editing === 'type' && !mod && !event.shiftKey) {
      const move = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[event.key as 'ArrowUp'];
      if (move) {
        event.preventDefault();
        finish(move);
      }
    }
  };
  return (
    <TableCell
      className="relative border-r p-0 align-top"
      style={owner ? { boxShadow: `inset 0 0 0 2px ${editorColour(owner.userId)}` } : undefined}
      title={owner ? `${owner.name} is in this cell` : title}
    >
      {owner ? (
        <span
          aria-label={`${owner.name} is in this cell`}
          className="absolute -top-2 right-0.5 z-10 rounded px-1 text-[9px] leading-tight font-semibold text-white"
          style={{ background: editorColour(owner.userId) }}
        >
          {initials(owner.name)}
        </span>
      ) : null}
      <textarea
        aria-label={label}
        className={cn(
          'block min-h-8 min-w-[max(100%,5.5rem)] resize-none bg-transparent px-2 py-1.5 leading-snug outline-none [field-sizing:content]',
          'focus:ring-ring cursor-cell focus:ring-2 focus:ring-inset',
          editing && 'bg-background ring-primary cursor-text ring-2 ring-inset',
          numeric && 'text-right font-mono tabular-nums',
          wide ? 'min-w-56 max-w-[22rem]' : 'max-w-[14rem]',
          readOnly && 'text-muted-foreground',
        )}
        data-cell={cell}
        data-editing={editing || undefined}
        data-locked={readOnly || undefined}
        onBlur={leave}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange?.(event.target.value);
        }}
        onDoubleClick={() => edit('edit')}
        onFocus={() => {
          if (cell && !readOnly) live.focusCell(cell);
        }}
        onKeyDown={key}
        readOnly={readOnly || !editing}
        ref={ref}
        rows={1}
        spellCheck={false}
        value={draft}
      />
    </TableCell>
  );
}
