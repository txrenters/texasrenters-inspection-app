'use client';

import { CLIENT_VIEW_LABEL, type InvoiceClientView, type InvoiceDetail } from '@texasrenters/shared';
import { PaperclipIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { InvoiceFiles, InvoiceNotes } from '@/components/invoices/invoice-parts';
import { AsideCard } from '@/components/record/record-kit';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useInvoiceRecords } from '@/lib/invoice-record-queries';

/**
 * An invoice's internal notes and its files (2026-11-10, phase 4 of the
 * invoice gap review): Jobber's, read from it, and the office's own, written
 * here -- which a re-read of Jobber never touches, and which whoever makes
 * invoices can take off again.
 */

export function InvoiceNotesCard({ invoice, mayWrite }: { invoice: InvoiceDetail; mayWrite: boolean }) {
  const id = useId();
  const records = useInvoiceRecords(invoice.id);
  const [draft, setDraft] = useState('');
  const notes = invoice.details?.notes ?? [];
  if (!notes.length && !mayWrite) return null;

  const add = () =>
    records.addNote.mutate(draft, {
      onSuccess: () => {
        setDraft('');
        toast.success('Note added');
      },
      onError: (error) => toast.error('The note was not added', { description: error.message }),
    });
  const remove = (noteId: string) =>
    records.removeNote.mutate(noteId, {
      onSuccess: () => toast.success('Note taken off'),
      onError: (error) => toast.error('The note was not taken off', { description: error.message }),
    });

  return (
    <AsideCard title="Internal notes">
      {notes.length ? (
        <InvoiceNotes notes={notes} onRemove={mayWrite ? remove : undefined} removing={records.removeNote.isPending} />
      ) : null}
      {mayWrite ? (
        <div className="mt-3 grid gap-2">
          <Label className="sr-only" htmlFor={`${id}-note`}>
            A note
          </Label>
          <Textarea
            className="min-h-16"
            id={`${id}-note`}
            maxLength={10_000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="A note for the office. The client never sees it."
            value={draft}
          />
          <Button className="justify-self-end" disabled={!draft.trim() || records.addNote.isPending} onClick={add} size="sm" variant="outline">
            {records.addNote.isPending ? 'Adding…' : 'Add note'}
          </Button>
        </div>
      ) : null}
    </AsideCard>
  );
}

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic';

export function InvoiceFilesCard({ invoice, mayWrite }: { invoice: InvoiceDetail; mayWrite: boolean }) {
  const records = useInvoiceRecords(invoice.id);
  const input = useRef<HTMLInputElement>(null);
  const files = invoice.details?.files ?? [];
  if (!files.length && !mayWrite) return null;

  const add = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10_000_000) return void toast.error('The file was not added', { description: 'A file is at most 10 MB.' });
    records.addFile.mutate(file, {
      onSuccess: () => toast.success(`${file.name} added`),
      onError: (error) => toast.error('The file was not added', { description: error.message }),
    });
  };
  const remove = (fileId: string) =>
    records.removeFile.mutate(fileId, {
      onSuccess: () => toast.success('File taken off'),
      onError: (error) => toast.error('The file was not taken off', { description: error.message }),
    });

  return (
    <AsideCard
      action={
        mayWrite ? (
          <>
            <input
              accept={ACCEPT}
              aria-label="Choose a file to add"
              className="sr-only"
              onChange={(event) => {
                add(event.target.files?.[0]);
                event.target.value = '';
              }}
              ref={input}
              type="file"
            />
            <Button disabled={records.addFile.isPending} onClick={() => input.current?.click()} size="sm" variant="outline">
              <PaperclipIcon />
              {records.addFile.isPending ? 'Adding…' : 'Add file'}
            </Button>
          </>
        ) : undefined
      }
      title="Files"
    >
      {files.length ? (
        <InvoiceFiles files={files} invoiceId={invoice.id} onRemove={mayWrite ? remove : undefined} removing={records.removeFile.isPending} />
      ) : (
        <p className="text-muted-foreground text-sm">No files. Add a photo or a PDF, up to 10 MB.</p>
      )}
    </AsideCard>
  );
}

/** Jobber's "Client view": what the client sees on the invoice's PDF and email. */
export function ClientViewFields({ value, onChange }: { value: InvoiceClientView; onChange: (next: InvoiceClientView) => void }) {
  const id = useId();
  return (
    <fieldset className="bg-card grid gap-3 rounded-lg border p-4">
      <legend className="text-heading px-1 text-base font-bold">Client view</legend>
      <p className="text-muted-foreground -mt-1 text-sm">What the client sees on the invoice&apos;s PDF and email.</p>
      {(Object.keys(CLIENT_VIEW_LABEL) as (keyof InvoiceClientView)[]).map((key) => (
        <div className="flex items-center justify-between gap-3" key={key}>
          <Label className="font-normal" htmlFor={`${id}-${key}`}>
            {CLIENT_VIEW_LABEL[key]}
          </Label>
          <Switch checked={value[key]} id={`${id}-${key}`} onCheckedChange={(checked) => onChange({ ...value, [key]: checked })} />
        </div>
      ))}
    </fieldset>
  );
}
