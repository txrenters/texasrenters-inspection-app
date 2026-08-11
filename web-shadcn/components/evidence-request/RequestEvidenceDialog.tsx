'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { fetchAreaChecklist } from '@/lib/area-checklist';
import { useAdminMutations, useAreaEvidenceSummary } from '@/lib/queries';

/**
 * Ask the technician for more evidence in one specific area.
 *
 * Replaces a button that only relabelled the inspection. "Request more evidence"
 * used to call `under-review`, which sets a status the technician's queue does
 * not include — the office could record that something was missing, but nothing
 * ever reached the field and the technician had to be phoned.
 *
 * The server now hands the inspection back in the same transaction that stores
 * the request, so this dialog says so plainly: submitting it puts the job back
 * on the technician's handset.
 */
export function RequestEvidenceDialog({
  inspectionId,
  onClose,
}: {
  inspectionId: string;
  onClose: () => void;
}) {
  const mutations = useAdminMutations();
  const areas = useAreaEvidenceSummary(inspectionId).data?.areas ?? [];
  const [areaId, setAreaId] = useState('');
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [note, setNote] = useState('');

  const selected = areas.find((area) => area.id === areaId);
  // Checklist items are per catalog area, not per inspection area — the request
  // stores inspection-area ids, but the items hang off the catalog.
  const checklist = useQuery({
    queryKey: ['admin', 'property-area', selected?.propertyAreaId ?? '', 'checklist'],
    queryFn: ({ signal }) => fetchAreaChecklist(selected!.propertyAreaId, signal),
    enabled: Boolean(selected?.propertyAreaId),
  });
  const mutation = mutations.createEvidenceRequest;
  const noteReady = note.trim().length >= 3;

  const submit = () => {
    if (!areaId || !noteReady) return;
    mutation.mutate(
      {
        id: inspectionId,
        inspectionAreaId: areaId,
        // Omitted rather than sent empty when nothing is picked — the server
        // reads an empty list as "the whole area", which is the same intent.
        ...(itemIds.length ? { checklistItemIds: itemIds } : {}),
        note: note.trim(),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <AlertDialog onOpenChange={(open) => (!open ? onClose() : undefined)} open>
      <AlertDialogContent className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Request more evidence</AlertDialogTitle>
          <AlertDialogDescription>
            Names what is missing and returns the inspection to the assigned technician. Existing
            recordings, photos and findings are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-4">
          <Field>
            <FieldLabel htmlFor="evidence-area">Area</FieldLabel>
            <Select
              onValueChange={(value) => {
                setAreaId(value);
                // Items belong to the area that was open; keeping them would
                // send ids the new area's checklist does not contain.
                setItemIds([]);
              }}
              value={areaId}
            >
              <SelectTrigger className="w-full" id="evidence-area">
                <SelectValue placeholder="Choose an area" />
              </SelectTrigger>
              <SelectContent>
                {areas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                    {area.floorName ? ` · ${area.floorName}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {selected ? (
            <Field>
              <FieldLabel asChild>
                <span>Checklist items (optional)</span>
              </FieldLabel>
              {/* Leaving every box clear asks for the whole area, which is how a
                  reviewer requests a re-walk rather than one detail. */}
              <FieldDescription>
                {itemIds.length
                  ? `${itemIds.length} item${itemIds.length === 1 ? '' : 's'} selected`
                  : 'Nothing selected — the request covers the whole area.'}
              </FieldDescription>
              {checklist.data?.length ? (
                <ul className="max-h-48 overflow-y-auto rounded-md border p-1">
                  {checklist.data.map((item) => {
                    const checked = itemIds.includes(item.id);
                    return (
                      <li key={item.id}>
                        <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() =>
                              setItemIds((current) =>
                                checked
                                  ? current.filter((id) => id !== item.id)
                                  : [...current, item.id],
                              )
                            }
                          />
                          {item.label}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <FieldDescription>
                  This area has no checklist configured, so the request covers the whole area.
                </FieldDescription>
              )}
            </Field>
          ) : null}

          <Field>
            <FieldLabel htmlFor="evidence-note">What is needed</FieldLabel>
            <Textarea
              id="evidence-note"
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Need a close-up of the water stain above the window."
              value={note}
            />
            {/* Required, and said before the button is pressed rather than as a
                400 afterwards: a request that does not say what is wrong sends
                the technician back to a finished room with nothing to act on. */}
            <FieldError>
              {note.length > 0 && !noteReady
                ? 'Describe what the technician needs to capture.'
                : null}
            </FieldError>
          </Field>

          {mutation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : 'The request could not be sent.'}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Cancel</AlertDialogCancel>
          <Button
            disabled={!areaId || !noteReady || mutation.isPending}
            onClick={submit}
            type="button"
          >
            {mutation.isPending ? <Spinner /> : null}
            {mutation.isPending ? 'Sending…' : 'Send to technician'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
