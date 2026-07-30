import type { Finding } from '../domain/models';

/**
 * Presentation rules for AI output shown to a technician.
 *
 * Kept UI-free and pure so the wording — which carries real weight, because a
 * technician may act on it in someone's home — is testable.
 */

/**
 * The backend stores each room's narrative AI summary as a finding row with
 * this exact title (`ROOM_SUMMARY_TITLE` in media-processing.service.ts). The
 * server can filter on it via `?kind=`; this constant exists for the mock
 * repository and for defensive filtering on the client.
 */
export const ROOM_SUMMARY_TITLE = 'Room condition summary';

export const isRoomSummary = (finding: Pick<Finding, 'title'>) =>
  finding.title.trim().toLowerCase() === ROOM_SUMMARY_TITLE.toLowerCase();

/** Plain-language labels. The raw enum values are not technician-facing. */
export const COMPARISON_LABELS: Record<Finding['comparisonResult'], string> = {
  POSSIBLE_NEW_DAMAGE: 'Possible new damage',
  EXISTING_CONDITION: 'Pre-existing condition',
  NO_MATERIAL_CHANGE: 'No material change',
  NORMAL_WEAR: 'Normal wear and tear',
  OWNER_MAINTENANCE: 'Owner maintenance',
  MISSING_EVIDENCE: 'Missing evidence',
  INSUFFICIENT_DATA: 'Not enough information',
};

export const SEVERITY_LABELS: Record<Finding['severity'], string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

export const REVIEW_STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: 'Awaiting office review',
  APPROVED: 'Accepted by the office',
  EDITED: 'Edited by the office',
  REJECTED: 'Dismissed by the office',
  REINSPECTION_REQUESTED: 'Reinspection requested',
};

export const reviewStatusLabel = (status: string) =>
  REVIEW_STATUS_LABELS[status] ?? 'Awaiting office review';

/**
 * Confidence as a band rather than a bare percentage.
 *
 * A number alone invites false precision — "82%" reads as authoritative when it
 * is a model's self-report. The band, plus an explicit instruction to verify
 * low-confidence items, is what a technician can actually act on.
 */
export type ConfidenceBand = {
  label: string;
  percent: number;
  /** True when the technician should physically re-check before relying on it. */
  needsVerification: boolean;
};

export function describeConfidence(confidence: number): ConfidenceBand {
  // Anything outside both plausible scales is a fault, not a low score. Clamping
  // it would be actively harmful: a garbage 150 would clamp to "100% — high
  // confidence", presenting a broken value as certainty. Fail to "unknown".
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
    return { label: 'Confidence unavailable', percent: 0, needsVerification: true };

  // Accept both 0–1 and 0–100 shapes; the API has used both over time, and 0.82
  // rendered as "1%" would quietly mislead in the other direction.
  const bounded = confidence > 1 ? confidence / 100 : confidence;
  const percent = Math.round(bounded * 100);
  if (bounded >= 0.8) return { label: 'High confidence', percent, needsVerification: false };
  if (bounded >= 0.5) return { label: 'Medium confidence', percent, needsVerification: true };
  return { label: 'Low confidence', percent, needsVerification: true };
}

/** `m:ss`, for referring back to a point in the walkthrough recording. */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The moment in the recording a finding refers to.
 *
 * Returns null when the range carries no information, so the UI can omit the
 * row entirely rather than print a meaningless "0:00 – 0:00".
 */
export function formatTimestampRange(start: number, end: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start <= 0 && end <= 0) return null;
  if (end <= start) return formatTimestamp(start);
  return `${formatTimestamp(start)} – ${formatTimestamp(end)}`;
}

export type FindingTone = 'danger' | 'warning' | 'info' | 'neutral';

/**
 * Tone is driven by the comparison result first, not severity.
 *
 * A HIGH-severity crack that the AI matched to the move-in baseline is not the
 * tenant's problem, and colouring it red would push the technician toward the
 * wrong conclusion in front of a resident.
 */
export function findingTone(finding: Pick<Finding, 'severity' | 'comparisonResult'>): FindingTone {
  switch (finding.comparisonResult) {
    case 'POSSIBLE_NEW_DAMAGE':
      return finding.severity === 'LOW' ? 'warning' : 'danger';
    case 'MISSING_EVIDENCE':
    case 'INSUFFICIENT_DATA':
      return 'warning';
    case 'EXISTING_CONDITION':
    case 'NORMAL_WEAR':
    case 'OWNER_MAINTENANCE':
      return 'info';
    default:
      return 'neutral';
  }
}

/**
 * The single sentence that must accompany any AI output shown in the field.
 *
 * Technicians cannot accept or dismiss findings — that is an authorized
 * reviewer's decision — and nothing here determines tenant responsibility or
 * charges. Centralised so the wording cannot drift between screens.
 */
export const AI_REVIEW_DISCLAIMER =
  'AI findings are suggestions for an authorized reviewer. They do not determine tenant responsibility or charges. Report what you observed — the office decides.';
