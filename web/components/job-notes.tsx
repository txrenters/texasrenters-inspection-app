'use client';

import {
  MAX_OFFICE_NOTE,
  OFFICE_NOTE_PERMISSIONS,
  reportComments,
  technicianNotes,
  type AdminInspection,
  type JobNote,
  type OfficeNote,
  type OfficeNoteInput,
} from '@texasrenters/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth, usePermissions } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { useOfficeNoteMutations } from '@/lib/queries';

/**
 * Everything written on a job, in one section, in both layouts (the office,
 * 2026-11-06: "it should show the notes the technician submitted and office can
 * also make their own").
 *
 * The report's closing comments are a group of their own because they are not
 * notes between the technician and the office: a tenant and an owner read them.
 *
 * The office writes in `OfficeNotes`, at any time, and only its author changes a
 * note. `internalNotes` stays below them as the booking note: mostly the
 * system's words, on the technician's phone, and locked with the job.
 */

function NoteGroup({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section aria-label={title} className="grid content-start gap-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function NoteList({ notes }: { notes: readonly JobNote[] }) {
  return (
    <dl className="grid gap-3 text-sm">
      {notes.map((note) => (
        <div className="grid gap-0.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4" key={note.key}>
          <dt className="text-muted-foreground break-words">{note.source}</dt>
          <dd className="break-words whitespace-pre-wrap">{note.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function NoteEditor({
  busy,
  initial,
  onCancel,
  onSave,
}: {
  busy: boolean;
  initial?: OfficeNote;
  onCancel: () => void;
  onSave: (input: OfficeNoteInput) => void;
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [shown, setShown] = useState(initial?.visibleToTechnician ?? false);
  const tick = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  // At the end of what is there: `autoFocus` leaves the caret before it, and a
  // change typed straight away landed in front of the note.
  useEffect(() => {
    const end = box.current?.value.length ?? 0;
    box.current?.focus();
    box.current?.setSelectionRange(end, end);
  }, []);
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ text, visibleToTechnician: shown });
      }}
    >
      <Textarea
        aria-label="Note"
        maxLength={MAX_OFFICE_NOTE}
        onChange={(event) => setText(event.target.value)}
        ref={box}
        value={text}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Checkbox checked={shown} id={tick} onCheckedChange={(value) => setShown(value === true)} />
          <Label htmlFor={tick}>Show to technician</Label>
        </div>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy || !text.trim()} size="sm" type="submit">
            {busy ? 'Saving…' : 'Save note'}
          </Button>
        </div>
      </div>
    </form>
  );
}

function OfficeNoteRow({
  mine,
  note,
  onDelete,
  onEdit,
}: {
  mine: boolean;
  note: OfficeNote;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const written = [
    note.author?.displayName ?? 'Former user',
    formatDateTime(note.createdAt),
    note.editedAt ? `edited ${formatDateTime(note.editedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="grid gap-1">
      <p className="text-sm break-words whitespace-pre-wrap">{note.text}</p>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{written}</span>
        {note.visibleToTechnician ? <Badge variant="info">Shown to technician</Badge> : null}
        {mine ? (
          <span className="flex gap-1">
            <Button aria-label="Edit note" className="h-7 px-2 text-xs" onClick={onEdit} size="sm" variant="ghost">
              Edit
            </Button>
            <Button aria-label="Delete note" className="h-7 px-2 text-xs" onClick={onDelete} size="sm" variant="ghost">
              Delete
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function OfficeNotes({
  bookingNoteAction,
  inspection,
}: {
  bookingNoteAction?: ReactNode;
  inspection: AdminInspection;
}) {
  const { hasAny } = usePermissions();
  const { profile } = useAuth();
  const { add, edit, remove } = useOfficeNoteMutations(inspection.id);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<OfficeNote | null>(null);

  const notes = inspection.officeNotes ?? [];
  const failed = (what: string) => (error: Error) => toast.error(what, { description: error.message });

  return (
    <NoteGroup
      action={
        hasAny(...OFFICE_NOTE_PERMISSIONS) && !writing ? (
          <Button className="h-7 px-2 text-xs" onClick={() => setWriting(true)} size="sm" variant="ghost">
            Add note
          </Button>
        ) : null
      }
      title="From the office"
    >
      {writing ? (
        <NoteEditor
          busy={add.isPending}
          onCancel={() => setWriting(false)}
          onSave={(input) =>
            add.mutate(input, {
              onSuccess: () => setWriting(false),
              onError: failed('The note was not saved'),
            })
          }
        />
      ) : null}

      {notes.length ? (
        <ul className="grid gap-3">
          {notes.map((note) => (
            <li key={note.id}>
              {editing === note.id ? (
                <NoteEditor
                  busy={edit.isPending}
                  initial={note}
                  onCancel={() => setEditing(null)}
                  onSave={(input) =>
                    edit.mutate(
                      { id: note.id, ...input },
                      { onSuccess: () => setEditing(null), onError: failed('The note was not changed') },
                    )
                  }
                />
              ) : (
                <OfficeNoteRow
                  mine={Boolean(profile) && note.author?.id === profile?.id}
                  note={note}
                  onDelete={() => setDeleting(note)}
                  onEdit={() => setEditing(note.id)}
                />
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {inspection.internalNotes ? (
        <div className="grid gap-1 border-t pt-2">
          <div className="flex min-h-7 items-center justify-between gap-2">
            <h4 className="text-muted-foreground text-xs">Booking note · on the technician&apos;s phone</h4>
            {bookingNoteAction}
          </div>
          <p className="text-sm break-words whitespace-pre-wrap">{inspection.internalNotes}</p>
        </div>
      ) : null}

      {!notes.length && !inspection.internalNotes && !writing ? (
        <p className="text-muted-foreground text-sm">No office notes yet.</p>
      ) : null}

      {deleting ? (
        <AlertDialog onOpenChange={(open) => (open ? undefined : setDeleting(null))} open>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this note?</AlertDialogTitle>
              <AlertDialogDescription>
                It comes off the job, and off the technician&apos;s phone if it was shown there. The job&apos;s
                activity keeps a record of what it said.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
              {/* Not AlertDialogAction: that closes on click, before the delete has answered. */}
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(deleting.id, {
                    onSuccess: () => setDeleting(null),
                    onError: failed('The note was not deleted'),
                  })
                }
                type="button"
                variant="destructive"
              >
                {remove.isPending ? 'Deleting…' : 'Delete note'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </NoteGroup>
  );
}

export function JobNotes({
  bookingNoteAction,
  inspection,
}: {
  /** "Edit", where the viewer may edit the inspection's details. */
  bookingNoteAction?: ReactNode;
  inspection: AdminInspection;
}) {
  const fromTechnician = technicianNotes(inspection);
  const onTheReport = reportComments(inspection);
  return (
    <Card aria-labelledby="notes-title" className="mt-4">
      <CardHeader>
        <CardTitle id="notes-title" variant="label">
          Notes
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <NoteGroup title="From the technician">
          {fromTechnician.length ? (
            <NoteList notes={fromTechnician} />
          ) : (
            <p className="text-muted-foreground text-sm">No notes from the technician.</p>
          )}
        </NoteGroup>
        {onTheReport.length ? (
          <NoteGroup title="Printed on the report">
            <NoteList notes={onTheReport} />
          </NoteGroup>
        ) : null}
        <OfficeNotes bookingNoteAction={bookingNoteAction} inspection={inspection} />
      </CardContent>
    </Card>
  );
}
