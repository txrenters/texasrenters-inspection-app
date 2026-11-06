import { reportComments, technicianNotes, type AdminInspection, type JobNote } from '@texasrenters/shared';
import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Everything written on a job, in one section, in both layouts (the office,
 * 2026-11-06: "it should show the notes the technician submitted and office can
 * also make their own").
 *
 * Read-only so far: the office's own notes get their own table later, and
 * `internalNotes` stays as it is until then.
 *
 * The report's closing comments are a group of their own because they are not
 * notes between the technician and the office: a tenant and an owner read them.
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

export function JobNotes({
  action,
  inspection,
}: {
  /** "Edit", where the viewer may edit the inspection's details. */
  action?: ReactNode;
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
        <NoteGroup action={action} title="From the office">
          {inspection.internalNotes ? (
            <p className="text-sm break-words whitespace-pre-wrap">{inspection.internalNotes}</p>
          ) : (
            <p className="text-muted-foreground text-sm">No office notes yet.</p>
          )}
        </NoteGroup>
      </CardContent>
    </Card>
  );
}
