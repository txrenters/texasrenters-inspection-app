'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  archiveChecklistItem,
  createChecklistItem,
  fetchAreaChecklist,
  type AreaChecklistItem,
} from '@/lib/area-checklist';

/**
 * Authoring surface for one area's coverage checklist.
 *
 * The list a technician sees while recording that area — what they are asked to
 * cover. An item ticks itself when its own wording is spoken during the
 * recording, matched against the AI summary, so the label is the whole of what
 * an administrator writes. The server derives the words to listen for; the API
 * still accepts explicit keywords for callers that need a synonym the label does
 * not contain.
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
  // Split by origin: a failed load belongs in the list region it replaces, a
  // failed add or remove belongs beside the control that triggered it. One
  // shared slot put "that label already exists" at the top of the dialog,
  // furthest from the button the reader had just pressed.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
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
      const created = await createChecklistItem(areaId, { label: trimmed });
      setItems((current) => [...current, created]);
      setLabel('');
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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/* A column rather than the default grid: only the item list scrolls, so
          the add form stays on screen however long the checklist grows. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{areaName} checklist</DialogTitle>
          <DialogDescription>
            What the technician is asked to cover while recording this area. Each item ticks itself
            when its wording is spoken, matched against the recording&apos;s AI summary.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
              <Spinner />
              Loading checklist…
            </p>
          ) : loadError ? (
            <Alert variant="destructive">
              <AlertDescription className="gap-3">
                {loadError}
                <Button onClick={() => void load()} size="sm" variant="outline">
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : items.length ? (
            <>
              <p className="text-muted-foreground mb-2 text-xs font-medium">
                {items.length === 1 ? '1 item' : `${items.length} items`}
              </p>
              <ul aria-label={`${areaName} checklist items`} className="grid gap-2">
                {items.map((item) => (
                  <li
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                    key={item.id}
                  >
                    <p className="min-w-0 text-sm font-medium break-words">{item.label}</p>
                    <Button
                      aria-label={`Remove ${item.label}`}
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => void remove(item)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2Icon />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
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
          <Field>
            <FieldLabel htmlFor="checklist-label">Add an item</FieldLabel>
            <Input
              id="checklist-label"
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Sink, taps and drainage"
              ref={labelInput}
              value={label}
            />
            <FieldDescription>
              Word it the way a technician would say it aloud - the item ticks itself when those
              words appear in the recording.
            </FieldDescription>
          </Field>

          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          <Button className="w-full" disabled={!label.trim() || saving} type="submit">
            {saving ? <Spinner /> : <PlusIcon />}
            {saving ? 'Adding…' : 'Add item'}
          </Button>
        </form>

        {/* The archive caveat only means something once there is something to
            remove, so it stays out of the way of an empty checklist. */}
        <DialogFooter className="shrink-0 sm:items-center sm:justify-between">
          {items.length ? (
            <p className="text-muted-foreground text-xs sm:max-w-[68%] sm:text-left">
              Removing an item archives it. Inspections that already recorded coverage against it
              keep resolving it.
            </p>
          ) : null}
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
