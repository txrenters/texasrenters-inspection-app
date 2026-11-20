'use client';

import { REQUISITION_STATUS_LABEL, formatMoney, type RequisitionDetail, type RequisitionRow } from '@texasrenters/shared';
import { useMemo, useState, type FormEvent } from 'react';

import type { PickerItem } from '@/components/purchasing/item-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatCount } from '@/lib/format';
import { readRequisition, useRequisitions } from '@/lib/purchasing-queries';
import { cn } from '@/lib/utils';

/** The requisition ribbon's dialogs (2026-11-20). */

const said = (error: unknown) => (error instanceof Error ? error.message : 'It could not be done.');

/** Send Back, Reject and Reopen: a note to whoever asked; needed for the first two. */
export function NoteDialog({
  title,
  description,
  confirmLabel,
  required,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  required: boolean;
  danger?: boolean;
  onConfirm: (note: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || (required && !note.trim())) return;
    setPending(true);
    setProblem(null);
    try {
      await onConfirm(note.trim());
      onClose();
    } catch (error) {
      setProblem(said(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
          <Textarea aria-label={required ? 'Note, needed' : 'Note'} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder={required ? 'Say why, so whoever asked knows what to do next.' : 'A note, if you like'} rows={3} value={note} />
          {problem ? (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={pending || (required && !note.trim())} type="submit" variant={danger ? 'destructive' : 'default'}>
              {pending ? <Spinner /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Delete: asked once, saying what happens. */
export function DeleteDialog({ name, saved, onConfirm, onClose }: { name: string; saved: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <AlertDialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {saved ? 'It is kept as Cancelled under the closed requisitions, with its history, and its number is not used again.' : 'Nothing has been saved yet, so nothing is kept.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-background"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Copy Document, as NAV's: another requisition's lines, and its General if
 * asked, copied into this one -- replacing the lines here, or added after
 * them. Only lines whose items this requisition's company buys are copied.
 * One read, of the requisition chosen.
 */
export function CopyDocumentDialog({ currentId, onCopy, onClose }: { currentId?: string; onCopy: (from: RequisitionDetail, options: { general: boolean; replace: boolean }) => string | null; onClose: () => void }) {
  const open = useRequisitions('open');
  const closed = useRequisitions('closed');
  const [words, setWords] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [general, setGeneral] = useState(false);
  const [replace, setReplace] = useState(true);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = useMemo(() => {
    const all: RequisitionRow[] = [...(open.data?.requisitions ?? []), ...(closed.data?.requisitions ?? [])].filter((row) => row.id !== currentId);
    const find = words.trim().toLowerCase();
    return find ? all.filter((row) => `${row.number ?? ''} ${row.requestedBy.name} ${row.summary}`.toLowerCase().includes(find)) : all;
  }, [open.data, closed.data, currentId, words]);

  const copy = async () => {
    if (!chosen) return;
    setPending(true);
    setProblem(null);
    try {
      const refused = onCopy(await readRequisition(chosen), { general, replace });
      if (refused) setProblem(refused);
      else onClose();
    } catch (error) {
      setProblem(said(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Copy Document</DialogTitle>
          <DialogDescription>Choose a requisition to copy its lines into this one. Only its company&rsquo;s items come across.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Find a requisition" onChange={(event) => setWords(event.target.value)} placeholder="Find by number, who asked, or what" value={words} />
        <div className="max-h-[45vh] overflow-y-auto rounded-sm border">
          {open.isLoading || closed.isLoading ? (
            <p className="text-muted-foreground p-3 text-sm">Reading the requisitions…</p>
          ) : rows.length ? (
            <ul aria-label="Requisitions to copy from" className="divide-y" role="listbox">
              {rows.map((row) => (
                <li
                  aria-selected={row.id === chosen}
                  className={cn('grid cursor-pointer grid-cols-[7rem_minmax(0,1fr)_7rem_6rem] gap-2 px-3 py-1.5 text-sm', row.id === chosen ? 'bg-accent' : 'hover:bg-muted')}
                  key={row.id}
                  onClick={() => setChosen(row.id)}
                  onDoubleClick={() => {
                    setChosen(row.id);
                    void copy();
                  }}
                  role="option"
                >
                  <span className="font-mono font-semibold">{row.number ?? 'Draft'}</span>
                  <span className="truncate">{row.summary || 'No lines'}</span>
                  <span className="text-muted-foreground">{REQUISITION_STATUS_LABEL[row.status]}</span>
                  <span className="text-right tabular-nums">{formatMoney(row.estimatedTotalCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground p-3 text-sm">No other requisition to copy from.</p>
          )}
        </div>
        <div className="grid gap-2 text-sm">
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={replace} onCheckedChange={(checked) => setReplace(checked === true)} />
            Replace the lines here (otherwise add after them)
          </Label>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={general} onCheckedChange={(checked) => setGeneral(checked === true)} />
            Copy its General too: company, request, location and cost center codes, expected date
          </Label>
        </div>
        {problem ? (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={!chosen || pending} onClick={() => void copy()} type="button">
            {pending ? <Spinner /> : null}
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Select From Item Categories: tick categories, then the items in them to
 * add, each at its reorder quantity unless changed. Only items this line may
 * take are offered: the requisition's company's, not already on it.
 */
export function CategoriesDialog({
  categories,
  items,
  onAdd,
  onClose,
}: {
  categories: readonly { id: string; name: string }[];
  items: readonly PickerItem[];
  onAdd: (picked: { item: PickerItem; quantity: number }[]) => void;
  onClose: () => void;
}) {
  const counted = categories.map((category) => ({ ...category, items: items.filter((item) => item.categoryId === category.id) })).filter((category) => category.items.length);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const shown = counted.filter((category) => ticked.has(category.id)).flatMap((category) => category.items);
  const quantityOf = (item: PickerItem) => chosen[item.id] ?? String(item.reorderQuantity || 1);
  const picked = shown.flatMap((item) => {
    const quantity = Number(quantityOf(item));
    return Number.isInteger(quantity) && quantity > 0 && chosen[`${item.id}:off`] !== '1' ? [{ item, quantity }] : [];
  });
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Select From Item Categories</DialogTitle>
          <DialogDescription>Tick categories, then choose the items to add and how many of each.</DialogDescription>
        </DialogHeader>
        {counted.length ? (
          <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
            <fieldset className="grid content-start gap-1.5">
              <legend className="text-heading mb-1 text-sm font-semibold">Categories</legend>
              {counted.map((category) => (
                <Label className="flex items-center gap-2 text-sm font-normal" key={category.id}>
                  <Checkbox
                    checked={ticked.has(category.id)}
                    onCheckedChange={(checked) =>
                      setTicked((now) => {
                        const next = new Set(now);
                        if (checked === true) next.add(category.id);
                        else next.delete(category.id);
                        return next;
                      })
                    }
                  />
                  {category.name} <span className="text-muted-foreground">({formatCount(category.items.length)})</span>
                </Label>
              ))}
            </fieldset>
            <div className="max-h-[50vh] overflow-y-auto rounded-sm border">
              {shown.length ? (
                <Table aria-label="Items in the categories ticked">
                  {/* Pinned to the top of this list's own scroll box, not under the app header (see components/ui/table.tsx). */}
                  <TableHeader className="sticky top-0 z-10 lg:top-0">
                    <TableRow>
                      <TableHead className="w-8">
                        <span className="sr-only">Add</span>
                      </TableHead>
                      <TableHead>No.</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">On Hand</TableHead>
                      <TableHead className="w-24 text-right">Quantity</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((item) => (
                      <TableRow key={item.id}>
                        <td className="px-2 py-1">
                          <Checkbox
                            aria-label={`Add ${item.code}`}
                            checked={chosen[`${item.id}:off`] !== '1'}
                            onCheckedChange={(checked) => setChosen((now) => ({ ...now, [`${item.id}:off`]: checked === true ? '' : '1' }))}
                          />
                        </td>
                        <td className="px-2 py-1 font-mono font-semibold whitespace-nowrap">{item.code}</td>
                        <td className="px-2 py-1">{item.name}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{formatCount(item.onHand)}</td>
                        <td className="px-2 py-1">
                          <Input aria-label={`How many ${item.code}`} className="h-7 text-right" inputMode="numeric" onChange={(event) => setChosen((now) => ({ ...now, [item.id]: event.target.value }))} value={quantityOf(item)} />
                        </td>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-muted-foreground p-3 text-sm">Tick a category to see its items.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No category has an item this requisition can still take.</p>
        )}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!picked.length}
            onClick={() => {
              onAdd(picked);
              onClose();
            }}
            type="button"
          >
            Add {picked.length ? formatCount(picked.length) : ''} {picked.length === 1 ? 'line' : 'lines'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

