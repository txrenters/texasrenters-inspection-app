/**
 * The rules behind reviewing a finding against its recording, kept apart from
 * the components so they are testable without a browser.
 */

import type { AreaFinding, FindingEditInput } from '@texasrenters/shared';
import { rejectReasonLabel } from '@texasrenters/shared';

/** Where in which recording a finding is, when the AI could say. */
export type FindingMoment = { recordingId: string; start: number; end: number };

/**
 * A finding's moment, or null when it has none worth seeking to.
 *
 * 0 to 0 is what the analysis writes when it had no timing to cite. Offering
 * "video 0:00" as a link would send the reviewer to the start of the recording
 * with a straight face, which is what made the old timestamps look broken.
 */
export function findingMoment(finding: AreaFinding): FindingMoment | null {
  if (!finding.recordingId) return null;
  const start = Math.max(0, Math.floor(finding.videoTimestampStart));
  const end = Math.max(start, Math.floor(finding.videoTimestampEnd));
  if (start === 0 && end === 0) return null;
  return { recordingId: finding.recordingId, start, end };
}

export function formatSeconds(total: number) {
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** "1:01–1:14", or "1:01" for a single moment. */
export function formatMoment(moment: Pick<FindingMoment, 'start' | 'end'>) {
  return moment.end > moment.start
    ? `${formatSeconds(moment.start)}–${formatSeconds(moment.end)}`
    : formatSeconds(moment.start);
}

/**
 * The seconds to show stills from, across a finding's moment.
 *
 * A second before it starts, because the technician usually names a problem
 * as the camera reaches it, and at least three seconds wide, because a
 * one-second moment is four copies of the same blur. Whole seconds, inside the
 * recording, without repeats.
 */
export function frameTimes(
  moment: Pick<FindingMoment, 'start' | 'end'>,
  durationSeconds: number,
  count = 4,
) {
  const last = Math.max(0, Math.floor(durationSeconds));
  const from = Math.min(last, Math.max(0, moment.start - 1));
  const to = Math.min(last, Math.max(moment.end, from + 3));
  if (to <= from) return [from];
  const step = (to - from) / (count - 1);
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(from + step * index)))];
}

/**
 * A still from a Stream recording at one second, from its signed thumbnail URL.
 *
 * Cloudflare renders any moment from the same signed URL with `?time=`, which
 * is what lets a reviewer look at a finding without playing the video at all.
 */
export function frameUrl(thumbnailUrl: string, seconds: number, height = 360) {
  const url = new URL(thumbnailUrl);
  const at = Math.max(0, seconds);
  // Whole seconds as they are; the AI's sharpest frame can sit half a second off.
  url.searchParams.set('time', `${Number.isInteger(at) ? at : at.toFixed(1)}s`);
  url.searchParams.set('height', String(height));
  return url.toString();
}

/**
 * What the comparison result means, in the reviewer's words.
 *
 * "missing evidence" was printed under 44 of 49 findings on one move-out, and
 * it meant the AI had no move-in to compare against, not that anything was
 * missing from the move-out.
 */
export function comparisonLabel(result: string) {
  switch (result) {
    case 'EXISTING_CONDITION':
      return 'Recorded at move-in';
    case 'POSSIBLE_NEW_DAMAGE':
      return 'Possibly new since move-in';
    case 'NO_MATERIAL_CHANGE':
      return 'No change since move-in';
    case 'NORMAL_WEAR':
      return 'Normal wear';
    case 'OWNER_MAINTENANCE':
      return 'Owner maintenance';
    case 'MISSING_EVIDENCE':
      return 'No move-in record to compare';
    case 'INSUFFICIENT_DATA':
      return 'Not enough to compare';
    default:
      return result.toLowerCase().replace(/_/g, ' ');
  }
}

/** What the AI saw when it looked for a finding in the recording, in a few words. */
export function visualLabel(finding: Pick<AreaFinding, 'source' | 'visual'>) {
  if (finding.source === 'AI_VISION') return 'Spotted by AI';
  if (finding.source === 'REVIEWER') return 'Added by a reviewer';
  switch (finding.visual?.status) {
    case 'VISIBLE':
      return 'Seen in video';
    case 'NOT_VISIBLE':
      return 'Not seen in video';
    case 'UNCLEAR':
      return 'Unclear in video';
    default:
      return null;
  }
}

/** What a move-in photograph of the same item shows, in a few words. */
export function baselineVisualLabel(status: string) {
  if (status === 'PRESENT_AT_MOVE_IN') return 'The move-in photo shows it too';
  if (status === 'NOT_AT_MOVE_IN') return 'Not in the move-in photo';
  return 'The move-in photo cannot tell';
}

/**
 * The frame to offer: the one already filed, else the AI's best not yet set
 * aside. Null when every suggestion was dismissed, or there were none.
 */
export function suggestionToOffer(finding: Pick<AreaFinding, 'frameSuggestions'>) {
  const suggestions = [...(finding.frameSuggestions ?? [])].sort((a, b) => a.rank - b.rank);
  return (
    suggestions.find((suggestion) => suggestion.status === 'ACCEPTED') ??
    suggestions.find((suggestion) => suggestion.status === 'SUGGESTED') ??
    null
  );
}

/**
 * A moment typed as the player shows it, "1:35" or "95", in whole seconds.
 * Null for anything else, and for nothing typed.
 */
export function parseMoment(text: string) {
  const value = text.trim();
  if (!value) return null;
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  if (/^\d{1,5}$/.test(value)) return Number(value);
  return null;
}

/** The AI's lean, worded as the suggestion it is. Null when it has none. */
export function responsibilityLabel(lean: string | null | undefined) {
  if (lean === 'TENANT_REVIEW_REQUIRED') return 'AI suggests checking tenant responsibility';
  if (lean === 'OWNER_REVIEW_REQUIRED') return 'AI suggests checking owner responsibility';
  return null;
}

/**
 * The finding to go to after a decision: the next one still awaiting one, after
 * this one and then from the top. Null when none is left.
 */
export function nextPending(findings: AreaFinding[], afterId: string | null) {
  const from = findings.findIndex((finding) => finding.id === afterId);
  const ordered = [...findings.slice(from + 1), ...findings.slice(0, Math.max(0, from))];
  return ordered.find((finding) => finding.reviewStatus === 'PENDING_REVIEW') ?? null;
}

/**
 * The decision on a finding, in a few words: "Approved with edits",
 * "Rejected · Normal wear". Null for a plain approval, which says nothing the
 * status does not.
 */
export function decisionLabel(lastReview: AreaFinding['lastReview']) {
  if (!lastReview) return null;
  if (lastReview.status === 'EDITED') return 'Approved with edits';
  if (lastReview.status === 'REJECTED') {
    const reason = rejectReasonLabel(lastReview.reasonCode);
    return reason ? `Rejected · ${reason}` : 'Rejected';
  }
  return null;
}

/**
 * Who decided, when, and why, for a decided finding: one line under it.
 * The reviewer's own note is kept last, as they wrote it.
 */
export function decisionLine(lastReview: NonNullable<AreaFinding['lastReview']>, when: string) {
  return [decisionLabel(lastReview), lastReview.reviewerName, when, lastReview.reason]
    .filter(Boolean)
    .join(' · ');
}

export type FindingSeverity = FindingEditInput['severity'];
export type FindingKind = FindingEditInput['findingType'];

export const SEVERITY_CHOICES: ReadonlyArray<{ value: FindingSeverity; label: string }> = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
];

export const FINDING_KIND_CHOICES: ReadonlyArray<{ value: FindingKind; label: string }> = [
  { value: 'POSSIBLE_NEW_DAMAGE', label: 'New damage' },
  { value: 'EXISTING_CONDITION', label: 'Existing' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'NO_CHANGE', label: 'No change' },
];

/**
 * A finding as the edit form starts it: what the AI wrote, with anything the
 * form cannot offer (an unknown severity or type) brought to the nearest choice
 * rather than sent back as something the server refuses.
 */
export function editableFinding(finding: AreaFinding): FindingEditInput {
  const severity = SEVERITY_CHOICES.find((choice) => choice.value === finding.severity);
  const kind = FINDING_KIND_CHOICES.find((choice) => choice.value === finding.findingType);
  return {
    title: finding.title,
    description: finding.description,
    severity: severity?.value ?? 'MEDIUM',
    findingType: kind?.value ?? 'MAINTENANCE',
    category: finding.category,
  };
}
