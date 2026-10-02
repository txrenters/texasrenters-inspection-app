'use client';

import type { AreaRecording, FindingEditInput } from '@texasrenters/shared';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  FINDING_KIND_CHOICES,
  formatSeconds,
  frameUrl,
  parseMoment,
  SEVERITY_CHOICES,
} from '@/lib/finding-review';
import { useAdminMutations, useVideoPlayback } from '@/lib/queries';

import { Choices } from './Choices';

/** The still at a moment, to see what will be filed before filing it. */
function MomentStill({ recordingId, seconds }: { recordingId: string; seconds: number }) {
  const thumbnailUrl = useVideoPlayback(recordingId).data?.thumbnailUrl;
  if (!thumbnailUrl) return null;
  // A signed Cloudflare thumbnail, not a page asset next/image could optimise.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={`The recording at ${formatSeconds(seconds)}`}
      className="bg-muted h-40 w-auto max-w-full rounded-md border object-contain"
      loading="lazy"
      src={frameUrl(thumbnailUrl, seconds)}
    />
  );
}

/**
 * A finding the AI missed, written by the reviewer who saw it.
 *
 * At a moment of one of the area's recordings, typed as the player shows it,
 * with the still at that moment shown so the reviewer can see it is the right
 * one, and filed as the finding's photograph if they want. Approved as it is
 * written: it is a person's finding. What reviewers add is what the AI is later
 * shown it missed.
 */
export function AddFindingForm({
  inspectionId,
  areaId,
  recordings,
  startSeconds,
  canCapture,
  onAdded,
  onCancel,
}: {
  inspectionId: string;
  areaId: string;
  /** The area's recordings; the first is the one playing. */
  recordings: AreaRecording[];
  /** Where to start the moment: the one playing, when known. */
  startSeconds: number | null;
  /** Filing the frame as a photograph needs `inspections:manage`. */
  canCapture: boolean;
  onAdded: (findingId: string) => void;
  onCancel: () => void;
}) {
  const { addFinding, captureSnapshot } = useAdminMutations();
  const [recordingId, setRecordingId] = useState(recordings[0]?.id ?? '');
  const [moment, setMoment] = useState(startSeconds ? formatSeconds(startSeconds) : '');
  const [draft, setDraft] = useState<FindingEditInput>({
    title: '',
    description: '',
    severity: 'MEDIUM',
    findingType: 'POSSIBLE_NEW_DAMAGE',
    category: '',
  });
  const [note, setNote] = useState('');
  const [fileFrame, setFileFrame] = useState(canCapture);
  const [photoError, setPhotoError] = useState<string | null>(null);
  // Set once the finding exists but its photograph failed: the form must not
  // offer to add the same finding a second time.
  const [addedId, setAddedId] = useState<string | null>(null);

  const recording = recordings.find((entry) => entry.id === recordingId);
  const seconds = parseMoment(moment);
  const momentInvalid = moment.trim() !== '' && seconds === null;
  const pastTheEnd =
    seconds !== null && recording?.durationSeconds ? seconds > recording.durationSeconds : false;
  const set = <K extends keyof FindingEditInput>(field: K, value: FindingEditInput[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const busy = addFinding.isPending || captureSnapshot.isPending;
  const ready =
    Boolean(recordingId) &&
    draft.title.trim().length >= 2 &&
    draft.category.trim().length >= 1 &&
    !momentInvalid &&
    !pastTheEnd;

  const submit = async () => {
    setPhotoError(null);
    try {
      const finding = await addFinding.mutateAsync({
        ...draft,
        note: note.trim() || undefined,
        inspectionId,
        areaId,
        recordingId,
        atSeconds: seconds ?? undefined,
      });
      if (fileFrame && canCapture && seconds !== null) {
        try {
          await captureSnapshot.mutateAsync({
            mediaId: recordingId,
            inspectionId,
            areaId,
            atMs: seconds * 1000,
            findingId: finding.id,
          });
        } catch (error) {
          // The finding stands; only its photograph is missing, and "Add
          // photo" on its stills can file it.
          setAddedId(finding.id);
          setPhotoError(
            `The finding was added, but its photograph was not: ${
              error instanceof Error ? error.message : 'the frame could not be filed.'
            }`,
          );
          return;
        }
      }
      onAdded(finding.id);
    } catch {
      // The mutation's error is shown below.
    }
  };

  return (
    <section aria-label="Add a finding" className="grid gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">Add what the AI missed</p>
      <p className="text-muted-foreground text-xs">
        Approved as you write it. The AI is shown what reviewers add, as findings it missed.
      </p>
      {recordings.length > 1 ? (
        <Choices
          choices={recordings.map((entry, index) => ({
            value: entry.id,
            label: `Recording ${index + 1}${entry.durationSeconds ? ` · ${formatSeconds(entry.durationSeconds)}` : ''}`,
          }))}
          disabled={busy}
          label="Recording"
          onChange={setRecordingId}
          value={recordingId}
        />
      ) : null}
      <div className="flex flex-wrap items-start gap-3">
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">At (m:ss, as the player shows)</span>
          <Input
            aria-invalid={momentInvalid || pastTheEnd}
            aria-label="Moment in the recording"
            className="w-28 tabular-nums"
            disabled={busy}
            inputMode="numeric"
            onChange={(event) => setMoment(event.target.value)}
            placeholder="1:35"
            value={moment}
          />
          {momentInvalid ? (
            <span className="text-destructive">Write it as 1:35</span>
          ) : pastTheEnd ? (
            <span className="text-destructive">Past the end of the recording</span>
          ) : null}
        </label>
        {seconds !== null && !pastTheEnd && recordingId ? (
          <MomentStill recordingId={recordingId} seconds={seconds} />
        ) : null}
      </div>
      <Input
        aria-label="Finding title"
        disabled={busy}
        maxLength={200}
        onChange={(event) => set('title', event.target.value)}
        placeholder="What is wrong, e.g. Cracked outlet cover by the window"
        value={draft.title}
      />
      <Textarea
        aria-label="Finding description"
        className="min-h-16"
        disabled={busy}
        maxLength={4000}
        onChange={(event) => set('description', event.target.value)}
        placeholder="What it looks like, where exactly"
        value={draft.description}
      />
      <Choices
        choices={SEVERITY_CHOICES}
        disabled={busy}
        label="Severity"
        onChange={(value) => set('severity', value)}
        value={draft.severity}
      />
      <Choices
        choices={FINDING_KIND_CHOICES}
        disabled={busy}
        label="Finding type"
        onChange={(value) => set('findingType', value)}
        value={draft.findingType}
      />
      <Input
        aria-label="Category"
        disabled={busy}
        maxLength={80}
        onChange={(event) => set('category', event.target.value)}
        placeholder="Category, e.g. Electrical"
        value={draft.category}
      />
      <Input
        aria-label="Note"
        disabled={busy}
        maxLength={1000}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note (optional)"
        value={note}
      />
      {canCapture ? (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            aria-label="File the frame as its photograph"
            checked={fileFrame && seconds !== null}
            disabled={busy || seconds === null}
            onCheckedChange={(checked) => setFileFrame(checked === true)}
          />
          File the frame at {seconds !== null ? formatSeconds(seconds) : 'the moment'} as its
          photograph
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {addedId ? (
          <Button onClick={() => onAdded(addedId)} size="sm" type="button">
            Done
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={onCancel} size="sm" type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!ready || busy} onClick={() => void submit()} size="sm" type="button">
              {busy ? <Spinner /> : null}
              {busy ? 'Adding…' : 'Add finding'}
            </Button>
          </>
        )}
      </div>
      {addFinding.error ? (
        <Alert variant="destructive">
          <AlertDescription>{addFinding.error.message}</AlertDescription>
        </Alert>
      ) : null}
      {photoError ? (
        <Alert variant="destructive">
          <AlertDescription>{photoError}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
