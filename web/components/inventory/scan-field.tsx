'use client';

import { normalizeStockCode } from '@texasrenters/shared';
import { ScanBarcodeIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Where a scan lands in the console (2026-11-19). A scanner device plugged
 * into the computer is a keyboard: it types what the label holds, which is
 * the item code, and presses Enter. So this is a text field that acts on
 * Enter, and typing the code by hand does exactly the same thing.
 *
 * The code is matched whole against the items the screen already holds:
 * nothing is asked of the server for a scan. The field empties and keeps the
 * cursor after each one, ready for the next label.
 */

export interface Scannable {
  id: string;
  code: string;
}

/** The item a scan names, by its whole code; capitals and stray spaces forgiven. */
export function scannedItem<Item extends Scannable>(items: readonly Item[], typed: string): Item | null {
  const code = normalizeStockCode(typed);
  if (!code) return null;
  return items.find((item) => item.code === code) ?? null;
}

export function ScanField<Item extends Scannable>({
  id,
  items,
  onItem,
  label = 'Scan or type an item code',
  hint,
  missing = (code) => `No item has the code ${code}.`,
  className,
}: {
  id: string;
  items: readonly Item[];
  /** Called with the item a scan names. Return words to say why it was not taken ("Not in this truck."), or nothing. */
  onItem: (item: Item) => string | void;
  label?: string;
  hint?: string;
  missing?: (code: string) => string;
  className?: string;
}) {
  const [typed, setTyped] = useState('');
  const [said, setSaid] = useState<{ words: string; bad: boolean } | null>(null);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Never the form's own submit: a scan inside a form must not save it.
    event.preventDefault();
    const code = normalizeStockCode(typed);
    if (!code) return;
    const item = scannedItem(items, typed);
    const refused = item ? onItem(item) : missing(code);
    setSaid(refused ? { words: refused, bad: true } : { words: `${code} found.`, bad: false });
    setTyped('');
  }

  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <ScanBarcodeIcon aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          autoCapitalize="characters"
          autoComplete="off"
          className="pl-9 font-mono"
          enterKeyHint="go"
          id={id}
          onChange={(event) => {
            setTyped(event.target.value);
            setSaid(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="FLT-16251"
          spellCheck={false}
          value={typed}
        />
      </div>
      <p aria-live="polite" className={cn('min-h-5 text-xs', said?.bad ? 'text-destructive font-medium' : 'text-muted-foreground')}>
        {said ? said.words : (hint ?? 'A scanner types the code and presses Enter. Typing it and pressing Enter does the same.')}
      </p>
    </div>
  );
}
