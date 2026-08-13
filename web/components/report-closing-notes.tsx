'use client';

import { useState } from 'react';
import type { AdminInspection } from '@texasrenters/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAdminMutations } from '@/lib/queries';

/**
 * The report's closing block, written at sign-off.
 *
 * Three fields rather than one note because the office's printed report prints
 * them as three headed columns, and they are read by different people: the
 * alert schedules the next visit, the maintenance comments become work orders,
 * and the general comments are what the tenant reads. Merging them would force
 * whoever reads one to sift the other two.
 *
 * Deliberately not part of the scheduling dialog, which edits when and how
 * urgently the inspection happens. This is content that goes on the document,
 * so it belongs beside the finalization panel where the reviewer is deciding
 * whether the report is ready to send.
 */
export function ReportClosingNotes({
  inspection,
  readOnly,
}: {
  inspection: AdminInspection;
  /** Set once finalized — the report has been closed and possibly shared. */
  readOnly: boolean;
}) {
  const mutations = useAdminMutations();
  const [draft, setDraft] = useState({
    nextInspectionAlert: inspection.nextInspectionAlert ?? '',
    maintenanceComments: inspection.maintenanceComments ?? '',
    generalComments: inspection.generalComments ?? '',
  });

  const stored = {
    nextInspectionAlert: inspection.nextInspectionAlert ?? '',
    maintenanceComments: inspection.maintenanceComments ?? '',
    generalComments: inspection.generalComments ?? '',
  };
  const dirty = (Object.keys(stored) as (keyof typeof stored)[]).some(
    (key) => draft[key].trim() !== stored[key],
  );

  const fields = [
    {
      key: 'nextInspectionAlert' as const,
      label: 'Next inspection alert',
      hint: 'When the property should be seen again.',
      rows: 2,
    },
    {
      key: 'maintenanceComments' as const,
      label: 'Maintenance comments',
      hint: 'Work the property needs. Becomes the owner’s job list.',
      rows: 5,
    },
    {
      key: 'generalComments' as const,
      label: 'General comments',
      hint: 'Anything the tenant or owner should read.',
      rows: 5,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Report closing notes</CardTitle>
        <CardDescription>
          Printed at the end of the shared report. Leave a field empty to keep it off the report
          entirely.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
            <Textarea
              disabled={readOnly}
              id={field.key}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [field.key]: event.target.value }))
              }
              rows={field.rows}
              value={draft[field.key]}
            />
            <p className="text-muted-foreground text-xs">{field.hint}</p>
          </Field>
        ))}

        {mutations.updateInspection.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {mutations.updateInspection.error instanceof Error
                ? mutations.updateInspection.error.message
                : 'The notes could not be saved.'}
            </AlertDescription>
          </Alert>
        ) : null}

        {readOnly ? (
          <p className="text-muted-foreground text-xs">
            This inspection is finalized. Reopen it to change what the report says.
          </p>
        ) : (
          <Button
            // Sent trimmed, and an emptied field is sent as an empty string
            // rather than omitted — that is what clears it on the server. A
            // reviewer who deletes a comment must not watch it reappear.
            disabled={!dirty || mutations.updateInspection.isPending}
            onClick={() =>
              mutations.updateInspection.mutate({
                id: inspection.id,
                nextInspectionAlert: draft.nextInspectionAlert.trim(),
                maintenanceComments: draft.maintenanceComments.trim(),
                generalComments: draft.generalComments.trim(),
              })
            }
            type="button"
          >
            {mutations.updateInspection.isPending ? 'Saving…' : 'Save closing notes'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
