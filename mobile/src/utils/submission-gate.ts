/**
 * Whether an inspection can be handed to the office, and if not, why.
 *
 * Extracted from the review screen because the rule has a property worth
 * guaranteeing rather than commenting: **every blocking condition must be one
 * the technician can actually clear**. The previous version of this gate was
 * unsatisfiable — it required a completion status nothing ever wrote — and the
 * result was a technician standing in a finished unit unable to submit, with a
 * disabled button and no explanation.
 */

/** The subset of a report room the gate reads. */
export type SubmittableRoom = {
  id: string;
  name: string;
  isRequired: boolean;
  completionStatus: string;
  /** The AI's narrative for this area; null when analysis produced none. */
  summary?: string | null;
  /** When the technician attested the summary matches; undefined if not yet. */
  summaryConfirmedAt?: string;
  /**
   * A summary is still on its way for this area. Server-computed, and already
   * bounded there: a pipeline that dies mid-run stops reporting pending rather
   * than blocking submission forever.
   */
  analysisPending?: boolean;
};

/**
 * What counts as finished for the purpose of submitting.
 *
 * `RECORDING_SAVED` is deliberately absent and `UPLOADED` deliberately present.
 * A recording still on the phone is not evidence the office can review —
 * submitting on it hands over an inspection whose video may never arrive. Once
 * Cloudflare has the bytes, it is.
 */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'SKIPPED',
  'UPLOADED',
]);

export type SubmissionGate = {
  canSubmit: boolean;
  /** Undefined when submission is available. */
  blockedReason?: string;
  incompleteRequiredRooms: SubmittableRoom[];
  unconfirmedSummaryRooms: SubmittableRoom[];
  /** Areas whose summary has not arrived yet. Clears without the technician. */
  analysisPendingRooms: SubmittableRoom[];
};

export function evaluateSubmissionGate(
  rooms: readonly SubmittableRoom[],
  inspectionStatus: string,
): SubmissionGate {
  const incompleteRequiredRooms = rooms.filter(
    (room) => room.isRequired && !FINISHED_STATUSES.has(room.completionStatus),
  );

  /**
   * Only areas that actually have a summary can be awaiting confirmation.
   *
   * This is the whole reason the gate stays satisfiable. Analysis is not
   * guaranteed — the provider can be down, out of credits, or the audio
   * unusable — and gating on every area would strand the technician behind a
   * condition no amount of field work clears. An area with no summary has
   * nothing to confirm and never blocks.
   */
  const unconfirmedSummaryRooms = rooms.filter((room) => room.summary && !room.summaryConfirmedAt);

  /**
   * Areas whose summary has not arrived yet.
   *
   * Without this the confirmation step loses a race it cannot see. Analysis
   * lands roughly twenty seconds after an upload, and a technician who submits
   * inside that window has no summary to confirm — the check above passes
   * honestly, they submit, and the summary appears afterwards with nobody
   * having read it.
   *
   * Waiting is safe to require because it is the one blocking condition that
   * clears without the technician doing anything, and the server bounds it: a
   * stalled pipeline stops reporting pending, so this can never become the
   * permanent block the old gate was.
   */
  const analysisPendingRooms = rooms.filter((room) => room.analysisPending);

  const canSubmit =
    inspectionStatus === 'IN_PROGRESS' &&
    incompleteRequiredRooms.length === 0 &&
    analysisPendingRooms.length === 0 &&
    unconfirmedSummaryRooms.length === 0;

  // Ordered the way the technician has to resolve it: record, then wait for the
  // summary, then read it. An area with no evidence has no summary coming, and
  // a summary still being written cannot be confirmed yet.
  const blockedReason = canSubmit
    ? undefined
    : incompleteRequiredRooms.length
      ? 'Complete required rooms first'
      : analysisPendingRooms.length
        ? 'Waiting for AI analysis'
        : unconfirmedSummaryRooms.length
          ? 'Confirm AI summaries first'
          : 'Submission unavailable';

  return {
    canSubmit,
    blockedReason,
    incompleteRequiredRooms,
    unconfirmedSummaryRooms,
    analysisPendingRooms,
  };
}
