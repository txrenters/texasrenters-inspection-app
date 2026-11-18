'use client';

import { ChevronDownIcon, ChevronUpIcon, KeyboardIcon, SearchIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cellTextOf, focusTarget, parseCopied, pasteTargets } from '@/lib/sheet-navigation';

/**
 * The keyboard on Actual vs Budget's sheets, as in Excel (2026-11-18, the
 * office: "keyboard shortcuts also on the console spreadsheet and a searchable
 * cell/data", and "add a help too to access the shortcuts"):
 *
 *  - Ctrl+Z / Ctrl+Y take back and put again what was saved, a cell at a time
 *    -- or a pasted block at once -- each as a save of its own, so it reaches
 *    Excel and the history as any other;
 *  - a block copied from Excel pastes across and down from the selected cell;
 *  - Ctrl+F finds text in any cell of the sheet shown, every match marked;
 *  - ? (or the Shortcuts button) lists every shortcut.
 */

/** A cell anyone can save, as the sheet registers it by its name. */
export interface CellApi {
  /** Saves `text` in the cell, as typing it would; false when it was not kept. */
  save: (text: string) => Promise<boolean>;
  focus: () => void;
}

interface Change {
  cell: string;
  before: string;
  after: string;
}

interface SheetKeys {
  register: (cell: string, api: CellApi) => () => void;
  /** A save made by hand: one step to take back. */
  record: (changes: Change[]) => void;
  /** Paste a copied block from a cell: each value into its cell, as one step to take back. */
  paste: (from: HTMLTableCellElement, text: string) => Promise<void>;
  openHelp: () => void;
}

const Context = createContext<SheetKeys | null>(null);
/** The page's keyboard, or none outside Actual vs Budget (a cell then works as a plain one). */
export const useSheetKeys = () => useContext(Context);

const FindContext = createContext<RefObject<HTMLInputElement | null> | null>(null);
const FindState = createContext<{
  query: string;
  only: boolean;
  index: number;
  count: number;
  set: (next: Partial<{ query: string; only: boolean; index: number; count: number }>) => void;
} | null>(null);

/** Undo steps kept, at most. */
const STEPS = 100;

/** A text box being typed in: the page's own keys leave it alone. */
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && !target.readOnly && !target.disabled));

export function SheetKeysProvider({ children, area }: { children: ReactNode; area: RefObject<HTMLElement | null> }) {
  const cells = useRef(new Map<string, CellApi>());
  const undone = useRef<Change[][]>([]);
  const done = useRef<Change[][]>([]);
  const [help, setHelp] = useState(false);
  const findBox = useRef<HTMLInputElement | null>(null);
  const [find, setFind] = useState({ query: '', only: false, index: 0, count: 0 });
  const setFound = useCallback((next: Partial<typeof find>) => setFind((current) => ({ ...current, ...next })), []);
  const findValue = useMemo(() => ({ ...find, set: setFound }), [find, setFound]);

  const register = useCallback((cell: string, api: CellApi) => {
    cells.current.set(cell, api);
    return () => {
      if (cells.current.get(cell) === api) cells.current.delete(cell);
    };
  }, []);
  const record = useCallback((changes: Change[]) => {
    if (!changes.length) return;
    done.current = [...done.current, changes].slice(-STEPS);
    undone.current = [];
  }, []);

  // Each change of a step saved again as it was (undo) or as it became (redo); the step moves to the other list only
  // once every cell of it is saved.
  const replay = useCallback(async (from: RefObject<Change[][]>, to: RefObject<Change[][]>, side: 'before' | 'after', words: string) => {
    const step = from.current.at(-1);
    if (!step) return;
    const missing = step.filter((change) => !cells.current.has(change.cell));
    if (missing.length) {
      toast.error(`Nothing to ${words}`, { description: 'That cell is not on the sheet shown. Show its day and technician again first.' });
      return;
    }
    from.current = from.current.slice(0, -1);
    let kept = true;
    for (const change of step) kept = (await cells.current.get(change.cell)!.save(change[side])) && kept;
    cells.current.get(step[0]!.cell)?.focus();
    if (kept) to.current = [...to.current, step].slice(-STEPS);
    else toast.error(`Not all of it could be ${words === 'undo' ? 'undone' : 'redone'}`);
  }, []);

  const paste = useCallback(
    async (from: HTMLTableCellElement, text: string) => {
      const changes: Change[] = [];
      for (const { cell, text: value } of pasteTargets(from, parseCopied(text))) {
        const name = cell.querySelector('textarea')?.dataset.cell;
        const api = name ? cells.current.get(name) : undefined;
        // A Total, a worked-out figure, a read-only cell: what was pasted on it is left out.
        if (!name || !api || cell.querySelector('textarea')?.hasAttribute('data-locked')) continue;
        const before = cellTextOf(cell);
        if (before === value) continue;
        if (await api.save(value)) changes.push({ cell: name, before, after: value });
      }
      record(changes);
    },
    [record],
  );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      // Find, from anywhere on the page: the sheet's own, not the browser's.
      if (mod && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        findBox.current?.focus();
        findBox.current?.select();
        return;
      }
      if (typingIn(event.target)) return;
      if (mod && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'y' || event.shiftKey) void replay(undone, done, 'after', 'redo');
        else void replay(done, undone, 'before', 'undo');
        return;
      }
      if (event.key === '?' && !mod) {
        event.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [replay]);

  const value = useMemo(() => ({ register, record, paste, openHelp: () => setHelp(true) }), [register, record, paste]);
  return (
    <Context.Provider value={value}>
      <FindContext.Provider value={findBox}>
        <FindState.Provider value={findValue}>
          {children}
          <FindArea area={area} />
        </FindState.Provider>
      </FindContext.Provider>
      <ShortcutsDialog onClose={() => setHelp(false)} open={help} />
    </Context.Provider>
  );
}

// ── Find ────────────────────────────────────────────────────────────────────

/**
 * Every cell of the sheets shown whose text has what is looked for is marked,
 * the current one more strongly and scrolled to; with "only matching rows" the
 * others are hidden. Marks are attributes on the cells, so the sheets are
 * never drawn again for them, and they follow what the sheets show as it
 * changes.
 */
function FindArea({ area }: { area: RefObject<HTMLElement | null> }) {
  const find = useContext(FindState);
  const query = find?.query ?? '';
  const only = find?.only ?? false;
  const index = find?.index ?? 0;
  const set = find?.set;
  useEffect(() => {
    const root = area.current;
    if (!root || !set) return;
    let frame = 0;
    let lastCount = -1;
    const mark = () => {
      frame = 0;
      const wanted = query.trim().toLowerCase();
      const cells = Array.from(root.querySelectorAll<HTMLTableCellElement>('[data-slot=sheet] tbody td'));
      const hits = wanted ? cells.filter((cell) => cellTextOf(cell).toLowerCase().includes(wanted)) : [];
      const current = hits.length ? hits[((index % hits.length) + hits.length) % hits.length] : undefined;
      for (const cell of cells) {
        const state = cell === current ? 'current' : hits.includes(cell) ? 'match' : null;
        if (state) cell.setAttribute('data-find', state);
        else cell.removeAttribute('data-find');
      }
      for (const row of Array.from(root.querySelectorAll<HTMLTableRowElement>('[data-slot=sheet] tbody tr'))) {
        const hide = Boolean(wanted && only && !Array.from(row.cells).some((cell) => hits.includes(cell)));
        if (hide) row.setAttribute('data-find-hide', '');
        else row.removeAttribute('data-find-hide');
      }
      if (hits.length !== lastCount) {
        lastCount = hits.length;
        set({ count: hits.length });
      }
      return current;
    };
    const again = () => {
      if (!frame) frame = requestAnimationFrame(() => void mark());
    };
    mark()?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const watch = new MutationObserver(again);
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('input', again);
    return () => {
      watch.disconnect();
      root.removeEventListener('input', again);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [area, query, only, index, set]);
  return null;
}

/** The search box and the Shortcuts button, over the sheet. */
export function SheetFindBar() {
  const box = useContext(FindContext);
  const find = useContext(FindState);
  const keys = useSheetKeys();
  if (!find) return null;
  const step = (by: number) => find.set({ index: find.index + by });
  const shown = find.count ? `${(((find.index % find.count) + find.count) % find.count) + 1} of ${find.count}` : find.query.trim() ? 'No matches' : '';
  const toCurrent = () => {
    const current = document.querySelector<HTMLTableCellElement>('[data-slot=sheet] td[data-find=current]');
    if (current) focusTarget(current).focus();
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-64 flex-1 sm:max-w-md">
        <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute top-2.5 left-2.5 size-4" />
        <Input
          aria-label="Find in this sheet"
          className="pl-8"
          onChange={(event) => find.set({ query: event.target.value, index: 0 })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              toCurrent();
            }
          }}
          placeholder="Find a Job#, address, note…"
          ref={box}
          value={find.query}
        />
      </div>
      <span aria-live="polite" className="text-muted-foreground min-w-16 text-sm">
        {shown}
      </span>
      <Button aria-label="Previous match" disabled={!find.count} onClick={() => step(-1)} size="icon" variant="ghost">
        <ChevronUpIcon />
      </Button>
      <Button aria-label="Next match" disabled={!find.count} onClick={() => step(1)} size="icon" variant="ghost">
        <ChevronDownIcon />
      </Button>
      <label className="text-muted-foreground flex items-center gap-2 text-sm">
        <Checkbox checked={find.only} onCheckedChange={(on) => find.set({ only: on === true })} />
        Only matching rows
      </label>
      <Button className="ml-auto" onClick={() => keys?.openHelp()} size="sm" title="Keyboard shortcuts (?)" variant="outline">
        <KeyboardIcon />
        Shortcuts
      </Button>
    </div>
  );
}

// ── Help ────────────────────────────────────────────────────────────────────

export const SHORTCUTS: { group: string; rows: [string, string[]][] }[] = [
  {
    group: 'Moving',
    rows: [
      ['Move between cells', ['←', '→', '↑', '↓']],
      ['Start / end of the row', ['Home', 'End']],
      ['First / last cell', ['Ctrl Home', 'Ctrl End']],
      ['Up / down a screen', ['PgUp', 'PgDn']],
    ],
  },
  {
    group: 'Editing',
    rows: [
      ['Edit the cell', ['F2', 'or type']],
      ['Save and go down / up', ['Enter', '⇧ Enter']],
      ['Save and go right / left', ['Tab', '⇧ Tab']],
      ['Cancel the edit', ['Esc']],
      ['New line in a note', ['⇧ Enter while editing']],
    ],
  },
  {
    group: 'Changing',
    rows: [
      ['Undo / redo a save', ['Ctrl Z', 'Ctrl Y']],
      ['Copy / paste cells', ['Ctrl C', 'Ctrl V']],
      ['Clear the cell', ['Delete']],
    ],
  },
  {
    group: 'Finding',
    rows: [
      ['Find in this sheet', ['Ctrl F']],
      ['Next / previous match', ['Enter', '⇧ Enter']],
      ['Back to the sheet', ['Esc']],
    ],
  },
  { group: 'Help', rows: [['Show these shortcuts', ['?']]] },
];

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog onOpenChange={(next) => (next ? null : onClose())} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Total rows and worked-out figures can be selected and copied, not edited.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 sm:grid-cols-2">
          {SHORTCUTS.map((section) => (
            <section key={section.group}>
              <h3 className="text-muted-foreground mt-3 mb-1 text-xs font-medium">{section.group}</h3>
              <dl>
                {section.rows.map(([what, keys]) => (
                  <div className="flex items-center justify-between gap-3 border-b py-1.5 text-sm" key={what}>
                    <dt className="text-muted-foreground">{what}</dt>
                    <dd className="flex flex-wrap justify-end gap-1">
                      {keys.map((key) =>
                        key.startsWith('or ') || key.includes(' while ') ? (
                          <span className="text-muted-foreground text-xs" key={key}>
                            {key.includes(' while ') ? (
                              <>
                                <kbd className="bg-muted rounded border px-1.5 font-mono text-[11px]">{key.split(' while ')[0]}</kbd> while editing
                              </>
                            ) : (
                              key
                            )}
                          </span>
                        ) : (
                          <kbd className="bg-muted rounded border px-1.5 font-mono text-[11px]" key={key}>
                            {key}
                          </kbd>
                        ),
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
