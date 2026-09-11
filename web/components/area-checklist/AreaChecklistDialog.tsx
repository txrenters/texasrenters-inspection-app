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
  fetchOccupiedChecklist,
  type AreaChecklistItem,
  type OccupiedChecklistItem,
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
  // Null while unknown or unreachable, [] when the organization genuinely
  // has none yet — the panel says something different for each.
  const [occupiedItems, setOccupiedItems] = useState<OccupiedChecklistItem[] | null>(null);
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
        /**
         * Both lists, because this area has two and the dialog used to imply
         * one. The occupied list never fails the dialog: it is a secondary
         * panel, and an administrator opening this to edit the room checklist
         * should not be blocked by a request that only informs.
         */
        const [areaItems, occupied] = await Promise.all([
          fetchAreaChecklist(areaId, signal),
          fetchOccupiedChecklist(signal).catch(() => null),
        ]);
        setItems(areaItems);
        setOccupiedItems(occupied);
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
          {/*
            This said "What the technician is asked to cover while recording this
            area", full stop — which is untrue on an occupied visit, and read to
            a reviewer as though a fifteen-minute walk still asked nine questions
            about a bathroom. It is the move-in, move-out and back-to-market
            list; occupied asks the two questions shown below it.
          */}
          <DialogDescription>
            What a <strong>move-in, move-out or back-to-market</strong> visit asks about this area.
            Each item ticks itself when its wording is spoken, matched against the recording&apos;s
            AI summary. An occupied visit asks the shorter list below instead.
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

          {/*
            The other list this area has.

            Shown here rather than on a settings page because this dialog is
            where somebody comes to ask "what does the technician see?", and
            answering with only half of it is what caused the confusion. Read
            only: these two rows are held once for the whole organization, so an
            edit control here would let somebody change every property while
            believing they had changed one room.
          */}
          {!loading && !loadError ? (
            <section aria-labelledby="occupied-checklist-heading" className="mt-6">
              <h3
                className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase"
                id="occupied-checklist-heading"
              >
                On an occupied visit
              </h3>
              <p className="text-muted-foreground mb-2 text-xs">
                The same two questions in every room, for the whole organization — not this area
                alone. An occupied inspection is walked in about fifteen minutes, so it asks these
                instead of the list above.
              </p>
              {occupiedItems === null ? (
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                  Could not load the occupied checklist.
                </p>
              ) : occupiedItems.length ? (
                <ul aria-label="Occupied inspection questions" className="grid gap-2">
                  {occupiedItems.map((item) => (
                    <li className="rounded-md border p-3" key={item.id}>
                      <p className="text-sm font-medium">{item.label}</p>
                      {item.choices?.length ? (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {item.choices.join(' · ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                /* Empty is a real state, not a fault: the rows are written when
                   an occupied inspection is created, so an organization whose
                   occupied visits all predate that has none yet. */
                <p className="text-muted-foreground rounded-md border border-dashed p-3 text-sm">
                  Not created yet. The two questions are written the first time an occupied
                  inspection is scheduled.
                </p>
              )}
            </section>
          ) : null}
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
