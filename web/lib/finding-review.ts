/**
 * The rules behind reviewing a finding against its recording, kept apart from
 * the components so they are testable without a browser.
 */

import type { AreaFinding } from '@texasrenters/shared';

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
  url.searchParams.set('time', `${Math.max(0, Math.floor(seconds))}s`);
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
