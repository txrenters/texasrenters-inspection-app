'use client';

import {
  REQUISITION_FILES_MAX,
  REQUISITION_FILE_ACCEPT,
  REQUISITION_FILE_MAX_BYTES,
  REQUISITION_FILE_TYPES,
  VENDOR_FILES_MAX_BYTES,
  formatFileSize,
  type RequisitionDetail,
  type RequisitionFile,
} from '@texasrenters/shared';
import { PaperclipIcon, XIcon } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';

import { FactBox } from '@/components/purchasing/nav-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatDate } from '@/lib/format';
import { openRequisitionFile, useRequisitionFiles } from '@/lib/purchasing-queries';
import { cn } from '@/lib/utils';

const said = (error: unknown) => (error instanceof Error ? error.message : 'It could not be done.');

/**
 * The Attachments FactBox (2026-11-20, part 3 of the NAV-style requisition),
 * as the office drew it: each file with its kind, size, who attached it and
 * when; a tick for the files that go to the vendor with the purchase order;
 * and a place to drop pictures or files, or press Attach.
 *
 * A requisition not yet saved has nowhere to keep a file, so it says so. The
 * server decides who may do what; this only draws it.
 */
export function AttachmentsFactBox({ requisition }: { requisition?: RequisitionDetail }) {
  if (!requisition)
    return (
      <FactBox title="Attachments">
        <p className="text-muted-foreground text-xs">Save the requisition first, then attach pictures or files to it.</p>
      </FactBox>
    );
  return <Attachments requisition={requisition} />;
}

function Attachments({ requisition }: { requisition: RequisitionDetail }) {
  const { attach, setForVendor, remove } = useRequisitionFiles(requisition.id);
  const chooser = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState<{ name: string; index: number; count: number; fraction: number } | null>(null);
  const [over, setOver] = useState(false);
  const { files } = requisition;
  const open = requisition.can.attach;
  const tickedBytes = files.filter((file) => file.forVendor).reduce((sum, file) => sum + file.sizeBytes, 0);

  /** One after another, so each shows its progress and the first refusal stops the rest. */
  async function add(chosen: File[]) {
    setProblem(null);
    if (!chosen.length) return;
    const room = REQUISITION_FILES_MAX - files.length;
    if (chosen.length > room) {
      setProblem(
        room > 0
          ? `Only ${room} more ${room === 1 ? 'file fits' : 'files fit'}: a requisition holds at most ${REQUISITION_FILES_MAX}.`
          : `A requisition holds at most ${REQUISITION_FILES_MAX} files. Take one off first.`,
      );
      return;
    }
    const tooBig = chosen.find((file) => file.size > REQUISITION_FILE_MAX_BYTES);
    if (tooBig) {
      setProblem(`${tooBig.name} is ${formatFileSize(tooBig.size)}; a file is at most ${formatFileSize(REQUISITION_FILE_MAX_BYTES)}.`);
      return;
    }
    for (const [index, file] of chosen.entries()) {
      setSending({ name: file.name, index, count: chosen.length, fraction: 0 });
      try {
        await attach.mutateAsync({ file, onProgress: (fraction) => setSending((now) => (now ? { ...now, fraction } : now)) });
      } catch (error) {
        setProblem(`${file.name}: ${said(error)}`);
        break;
      }
    }
    setSending(null);
  }

  function dropped(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    if (open && !sending) void add([...event.dataTransfer.files]);
  }

  async function show(file: RequisitionFile) {
    setProblem(null);
    try {
      if ((await openRequisitionFile(requisition.id, file.id)) === 'blocked') setProblem('The browser stopped the new tab. Allow pop-ups for the console, then open it again.');
    } catch (error) {
      setProblem(`${file.fileName}: ${said(error)}`);
    }
  }

  return (
    <FactBox title={`Attachments (${files.length})`}>
      {files.length ? (
        <ul aria-label="Attached files" className="grid gap-2">
          {files.map((file) => (
            <li className="grid gap-1 border-b pb-2 last:border-0 last:pb-0" key={file.id}>
              <div className="flex items-start gap-2">
                <span className="bg-muted text-muted-foreground mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold">{REQUISITION_FILE_TYPES[file.contentType]}</span>
                <div className="min-w-0 flex-1">
                  <button className="text-info block max-w-full truncate text-left font-medium hover:underline" onClick={() => void show(file)} title={file.fileName} type="button">
                    {file.fileName}
                  </button>
                  <p className="text-muted-foreground text-xs">
                    {formatFileSize(file.sizeBytes)} · {file.attachedBy.code}, {formatDate(file.attachedAt)}
                  </p>
                </div>
                {file.canRemove ? (
                  <Button
                    aria-label={`Take ${file.fileName} off`}
                    className="size-7 shrink-0"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(file.id, { onError: (error) => setProblem(`${file.fileName}: ${said(error)}`) })}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon className="size-4" />
                  </Button>
                ) : null}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  aria-label={`Send ${file.fileName} to the vendor with the PO`}
                  checked={file.forVendor}
                  disabled={!open || setForVendor.isPending}
                  onCheckedChange={(checked) =>
                    setForVendor.mutate({ fileId: file.id, forVendor: checked === true }, { onError: (error) => setProblem(`${file.fileName}: ${said(error)}`) })
                  }
                />
                Send to the vendor with the PO
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">Nothing is attached yet.</p>
      )}

      {tickedBytes > VENDOR_FILES_MAX_BYTES ? (
        <p className="text-warning mt-2 text-xs font-medium" role="status">
          Ticked for the vendor: {formatFileSize(tickedBytes)}. One email carries {formatFileSize(VENDOR_FILES_MAX_BYTES)} beside the PDF, so untick some before the order is sent.
        </p>
      ) : null}

      {open ? (
        <div
          className={cn('mt-2 grid justify-items-center gap-1.5 rounded-sm border border-dashed p-3 text-center', over && 'border-info bg-info/5')}
          data-testid="attachments-drop"
          onDragLeave={() => setOver(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDrop={dropped}
        >
          <p className="text-muted-foreground text-xs">Drop pictures or files here</p>
          <Button disabled={Boolean(sending)} onClick={() => chooser.current?.click()} size="sm" type="button" variant="outline">
            <PaperclipIcon className="size-4" />
            Attach&hellip;
          </Button>
          <input
            accept={REQUISITION_FILE_ACCEPT}
            aria-label="Choose files to attach"
            className="sr-only"
            multiple
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])];
              event.target.value = '';
              void add(chosen);
            }}
            ref={chooser}
            tabIndex={-1}
            type="file"
          />
          <p className="text-muted-foreground text-[11px]">PDF, pictures, Word, Excel · up to {formatFileSize(REQUISITION_FILE_MAX_BYTES)} each</p>
        </div>
      ) : (
        <p className="text-muted-foreground mt-2 text-xs">This requisition is finished with, so nothing more is attached to it.</p>
      )}

      {sending ? (
        <p className="text-muted-foreground mt-2 text-xs" role="status">
          Attaching {sending.name}
          {sending.count > 1 ? ` (${sending.index + 1} of ${sending.count})` : ''}… {Math.round(sending.fraction * 100)}%
        </p>
      ) : null}
      {problem ? (
        <Alert className="mt-2" variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
    </FactBox>
  );
}
