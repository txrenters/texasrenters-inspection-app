'use client';

import type { AreaFinding, FindingEditInput, FindingRejectReason } from '@texasrenters/shared';
import { FINDING_REJECT_REASONS } from '@texasrenters/shared';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  decisionLine,
  editableFinding,
  FINDING_KIND_CHOICES,
  SEVERITY_CHOICES,
} from '@/lib/finding-review';
import { formatDateTime } from '@/lib/format';
import { useAdminMutations } from '@/lib/queries';

import { Choices } from './Choices';

/**
 * Approve, correct or reject a finding, inline where its evidence is shown.
 *
 * Findings review is the one decision this screen exists to support, so it must
 * live beside the evidence rather than on a separate page-wide list -- in the
 * area panel, and in the viewer's review panel beside the photograph itself.
 * The decision is a person's: approving AI output is always a click here, never
 * something the mark on an area or anything else implies.
 *
 * A rejection picks a reason from a fixed list, and a nearly-right finding is
 * corrected rather than rejected. Both are what the AI is later shown as
 * lessons, so the list is worded the way the office decides.
 */
export function FindingReviewControls({
  finding,
  inspectionId,
  onDecided,
}: {
  finding: AreaFinding;
  inspectionId: string;
  /** After a decision is saved: the findings review moves on to the next one. */
  onDecided?: () => void;
}) {
  const { approveFinding, rejectFinding, editFinding } = useAdminMutations();
  const [mode, setMode] = useState<'idle' | 'rejecting' | 'editing'>('idle');
  const busy = approveFinding.isPending || rejectFinding.isPending || editFinding.isPending;

  if (finding.reviewStatus !== 'PENDING_REVIEW')
    return finding.lastReview ? (
      <p className="text-muted-foreground text-xs">
        {decisionLine(finding.lastReview, formatDateTime(finding.lastReview.createdAt))}
      </p>
    ) : (
      <p className="text-muted-foreground text-xs">Reviewed</p>
    );

  if (mode === 'rejecting')
    return (
      <RejectForm
        busy={busy}
        error={rejectFinding.error?.message}
        onBack={() => setMode('idle')}
        onReject={(reasonCode, reason) =>
          void rejectFinding
            .mutateAsync({ id: finding.id, inspectionId, reason, reasonCode })
            .then(() => {
              setMode('idle');
              onDecided?.();
            })
            .catch(() => undefined)
        }
        pending={rejectFinding.isPending}
      />
    );

  if (mode === 'editing')
    return (
      <EditForm
        busy={busy}
        error={editFinding.error?.message}
        finding={finding}
        onBack={() => setMode('idle')}
        onSave={(input) =>
          void editFinding
            .mutateAsync({ ...input, id: finding.id, inspectionId })
            .then(() => {
              setMode('idle');
              onDecided?.();
            })
            .catch(() => undefined)
        }
        pending={editFinding.isPending}
      />
    );

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() =>
            void approveFinding
              .mutateAsync({ id: finding.id, inspectionId })
              .then(() => onDecided?.())
              .catch(() => undefined)
          }
          size="sm"
          type="button"
        >
          {approveFinding.isPending ? <Spinner /> : null}
          {approveFinding.isPending ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setMode('editing')}
          size="sm"
          type="button"
          variant="outline"
        >
          Edit &amp; approve
        </Button>
        <Button
          disabled={busy}
          onClick={() => setMode('rejecting')}
          size="sm"
          type="button"
          variant="outline"
        >
          Reject
        </Button>
      </div>
      {approveFinding.error ? (
        <Alert variant="destructive">
          <AlertDescription>{approveFinding.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function RejectForm({
  busy,
  pending,
  error,
  onBack,
  onReject,
}: {
  busy: boolean;
  pending: boolean;
  error?: string;
  onBack: () => void;
  onReject: (reasonCode: FindingRejectReason | undefined, reason: string | undefined) => void;
}) {
  const [code, setCode] = useState<FindingRejectReason | null>(null);
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  // A reason from the list is enough; without one, or with Other, the note is
  // the only record of why the AI output was overruled, so it is required.
  const noteRequired = !code || code === 'OTHER';
  const ready = noteRequired ? trimmed.length >= 2 : trimmed.length !== 1;

  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground text-xs font-medium">Why is it rejected?</p>
      <Choices
        choices={FINDING_REJECT_REASONS.map((reason) => ({
          value: reason.code,
          label: reason.label,
        }))}
        disabled={busy}
        label="Rejection reason from the list"
        onChange={setCode}
        value={code}
      />
      <Textarea
        aria-label="Rejection reason"
        maxLength={1000}
        onChange={(event) => setNote(event.target.value)}
        placeholder={noteRequired ? 'Why is this finding rejected?' : 'Add a note (optional)'}
        value={note}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onBack} size="sm" type="button" variant="outline">
          Back
        </Button>
        <Button
          disabled={!ready || busy}
          onClick={() => onReject(code ?? undefined, trimmed || undefined)}
          size="sm"
          type="button"
          variant="destructive"
        >
          {pending ? <Spinner /> : null}
          {pending ? 'Rejecting…' : 'Confirm reject'}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function EditForm({
  finding,
  busy,
  pending,
  error,
  onBack,
  onSave,
}: {
  finding: AreaFinding;
  busy: boolean;
  pending: boolean;
  error?: string;
  onBack: () => void;
  onSave: (input: FindingEditInput) => void;
}) {
  const [draft, setDraft] = useState<FindingEditInput>(() => editableFinding(finding));
  const [note, setNote] = useState('');
  const set = <K extends keyof FindingEditInput>(field: K, value: FindingEditInput[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const ready = draft.title.trim().length >= 2 && draft.category.trim().length >= 1;

  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground text-xs font-medium">
        Correct what the AI wrote, then approve it
      </p>
      <Input
        aria-label="Finding title"
        disabled={busy}
        maxLength={200}
        onChange={(event) => set('title', event.target.value)}
        value={draft.title}
      />
      <Textarea
        aria-label="Finding description"
        className="min-h-20"
        disabled={busy}
        maxLength={4000}
        onChange={(event) => set('description', event.target.value)}
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
        placeholder="Category, e.g. Walls"
        value={draft.category}
      />
      <Input
        aria-label="Note on the correction"
        disabled={busy}
        maxLength={1000}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Note (optional)"
        value={note}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onBack} size="sm" type="button" variant="outline">
          Back
        </Button>
        <Button
          disabled={!ready || busy}
          onClick={() => onSave({ ...draft, note: note.trim() || undefined })}
          size="sm"
          type="button"
        >
          {pending ? <Spinner /> : null}
          {pending ? 'Saving…' : 'Save & approve'}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
