'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [keywords, setKeywords] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        setItems(await fetchAreaChecklist(areaId, signal));
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not load the checklist.');
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
    setError(null);
    try {
      const created = await createChecklistItem(areaId, {
        label: trimmed,
        keywords: parseKeywords(keywords),
      });
      setItems((current) => [...current, created]);
      setLabel('');
      setKeywords('');
    } catch (cause) {
      // Kept inline next to the field rather than shown as a toast: a duplicate
      // label is the common failure and needs a visible correction.
      setError(cause instanceof Error ? cause.message : 'Could not add the item.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: AreaChecklistItem) => {
    const previous = items;
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    try {
      await archiveChecklistItem(item.id);
    } catch (cause) {
      setItems(previous);
      setError(cause instanceof Error ? cause.message : 'Could not remove the item.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{areaName} checklist</DialogTitle>
          <DialogDescription>
            What the technician is asked to cover while recording this area. Keywords are the
            words that count as covering an item when spoken — matched against the recording&apos;s
            AI summary.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading checklist…
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.keywords.length
                      ? item.keywords.join(', ')
                      : 'No keywords — can only be ticked by hand'}
                  </p>
                </div>
                <Button
                  aria-label={`Remove ${item.label}`}
                  onClick={() => void remove(item)}
                  size="icon"
                  variant="ghost"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            ))}
            {!items.length ? (
              <li className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No items yet. The technician sees a generated fallback list until you add some.
              </li>
            ) : null}
          </ul>
        )}

        <div className="space-y-2 border-t pt-4">
          <label className="text-sm font-medium" htmlFor="checklist-label">
            Add an item
          </label>
          <Input
            id="checklist-label"
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
            placeholder="Sink, taps and drainage"
            value={label}
          />
          <Input
            aria-label="Keywords, comma separated"
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="sink, tap, faucet, drain"
            value={keywords}
          />
          <p className="text-xs text-muted-foreground">
            Comma separated. Saved lowercase and de-duplicated.
          </p>
          <Button className="w-full" disabled={!label.trim() || saving} onClick={() => void add()}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="mr-2 h-4 w-4" aria-hidden />
            )}
            {saving ? 'Adding…' : 'Add item'}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Removing an item archives it. Inspections that already recorded coverage against it keep
          resolving it.
        </p>
      </DialogContent>
    </Dialog>
  );
}
