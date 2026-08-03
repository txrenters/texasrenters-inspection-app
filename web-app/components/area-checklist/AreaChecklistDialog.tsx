'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  archiveChecklistItem,
  createChecklistItem,
  fetchAreaChecklist,
  parseKeywords,
  type AreaChecklistItem,
} from '@/lib/area-checklist';

/**
 * Authoring surface for one area's coverage checklist.
 *
 * The list a technician sees while recording that area. Items are what they are
 * asked to cover; keywords are the words that count as having covered it when
 * spoken, matched against the recording's AI summary.
 *
 * Removal archives rather than deletes, because an inspection that already
 * recorded coverage against an item still has to resolve it. The copy says so,
 * so nobody expects the row to disappear from history.
 *
 * Note on layout: this project omits Tailwind Preflight, so bare `p`, `ul` and
 * `li` keep their user-agent margins and the list keeps a 40px indent. Every
 * block here states its own spacing rather than inheriting a reset that does
 * not exist.
 */
export function AreaChecklistDialog({
  areaId,
  areaName,
  open,
  onOpenChange,
}: {
  areaId: string;
  areaName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [items, setItems] = useState<AreaChecklistItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Split by origin: a failed load belongs in the list region it replaces, a
  // failed add or remove belongs beside the control that triggered it. One
  // shared slot put "that label already exists" at the top of the dialog,
  // furthest from the button the reader had just pressed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [keywords, setKeywords] = useState('');
  const labelInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        setItems(await fetchAreaChecklist(areaId, signal));
      } catch (cause) {
        if (signal?.aborted) return;
        setLoadError(cause instanceof Error ? cause.message : 'Could not load the checklist.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [areaId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, open]);

  const add = async () => {
    const trimmed = label.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      const created = await createChecklistItem(areaId, {
        label: trimmed,
        keywords: parseKeywords(keywords),
      });
      setItems((current) => [...current, created]);
      setLabel('');
      setKeywords('');
      // A checklist is written several items at a time, so hand the caret back
      // rather than making the author click the first field again.
      labelInput.current?.focus();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not add the item.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: AreaChecklistItem) => {
    const previous = items;
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setActionError(null);
    try {
      await archiveChecklistItem(item.id);
    } catch (cause) {
      setItems(previous);
      setActionError(cause instanceof Error ? cause.message : 'Could not remove the item.');
    }
  };

  const countLabel = items.length === 1 ? '1 item' : `${items.length} items`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column rather than the default grid: only the item list scrolls, so
          the add form stays on screen however long the checklist grows. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{areaName} checklist</DialogTitle>
          <DialogDescription>
            What the technician is asked to cover while recording this area. Keywords are the words
            that count as covering an item when spoken, matched against the recording&apos;s AI
            summary.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="m-0 flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading checklist…
            </p>
          ) : loadError ? (
            <div
              className="flex flex-col items-start gap-2 rounded-md bg-destructive/10 p-4"
              role="alert"
            >
              <p className="m-0 text-sm text-destructive">{loadError}</p>
              <Button onClick={() => void load()} size="small" variant="secondary">
                Try again
              </Button>
            </div>
          ) : items.length ? (
            <>
              <p className="m-0 mb-2 text-xs font-medium text-muted-foreground">{countLabel}</p>
              <ul aria-label={`${areaName} checklist items`} className="m-0 list-none space-y-2 p-0">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <p className="m-0 text-sm font-medium">{item.label}</p>
                      <p className="m-0 mt-0.5 break-words text-xs text-muted-foreground">
                        {item.keywords.length
                          ? item.keywords.join(', ')
                          : 'No keywords — can only be ticked by hand'}
                      </p>
                    </div>
                    <Button
                      aria-label={`Remove ${item.label}`}
                      className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => void remove(item)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            /* Outside the list: an empty `ul` holding a non-item rendered a
               stray bullet, since nothing resets the user-agent list style. */
            <p className="m-0 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No items yet. The technician sees a generated fallback list until you add some.
            </p>
          )}
        </div>

        {/* A real form, so Enter submits from either field rather than only the
            one that happened to carry a keydown handler. */}
        <form
          className="shrink-0 space-y-3 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <p className="m-0 text-sm font-semibold">Add an item</p>

          <div>
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="checklist-label"
            >
              Item
            </label>
            <Input
              id="checklist-label"
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Sink, taps and drainage"
              ref={labelInput}
              value={label}
            />
          </div>

          <div>
            <label
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
              htmlFor="checklist-keywords"
            >
              Keywords <span className="font-normal">(optional)</span>
            </label>
            <Input
              aria-describedby="checklist-keywords-hint"
              id="checklist-keywords"
              onChange={(event) => setKeywords(event.target.value)}
              placeholder="sink, tap, faucet, drain"
              value={keywords}
            />
            <p className="m-0 mt-1.5 text-xs text-muted-foreground" id="checklist-keywords-hint">
              Comma separated, saved lowercase and de-duplicated. Without keywords the item can only
              be ticked by hand.
            </p>
          </div>

          {actionError ? (
            <p
              className="m-0 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {actionError}
            </p>
          ) : null}

          <Button className="w-full" disabled={!label.trim() || saving} type="submit">
            {saving ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="mr-2 size-4" aria-hidden />
            )}
            {saving ? 'Adding…' : 'Add item'}
          </Button>
        </form>

        {/* The archive caveat only means something once there is something to
            remove, so it stays out of the way of an empty checklist. */}
        <DialogFooter
          className={`shrink-0 ${items.length ? 'sm:items-center sm:justify-between' : ''}`}
          showCloseButton
        >
          {items.length ? (
            <p className="m-0 text-xs text-muted-foreground sm:max-w-[68%] sm:text-left">
              Removing an item archives it. Inspections that already recorded coverage against it
              keep resolving it.
            </p>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
