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
  /**
   * Areas still being analysed. Reported so the screen can say so, but never
   * blocking: analysis runs after the handover now.
   */
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

  /**
   * Every area finished is the whole rule.
   *
   * Confirming each AI summary used to be required too. That is gone: the
   * summaries are written after the fact and read by the office, so holding a
   * technician in the property until a language model has finished writing —
   * and until they have read it back — bought nothing the reviewer does not do
   * better with the video in front of them.
   *
   * It had also become unsatisfiable. The card that confirmed a summary was
   * removed from the area screen, so the condition survived with nothing left
   * that could clear it: a finished inspection, a greyed-out button, and no way
   * forward. Exactly the failure this module was extracted to prevent.
   */
  const canSubmit = inspectionStatus === 'IN_PROGRESS' && incompleteRequiredRooms.length === 0;

  const blockedReason = canSubmit
    ? undefined
    : incompleteRequiredRooms.length
      ? 'Complete required rooms first'
      : 'Submission unavailable';

  return { canSubmit, blockedReason, incompleteRequiredRooms, analysisPendingRooms };
}
