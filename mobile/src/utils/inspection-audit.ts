import type { Finding, InspectionRoom } from '../domain/models';
import { isRoomSummary } from './ai-review';

export type AuditPriority = 'ACT_NOW' | 'REVIEW' | 'MONITOR';

export interface PriorityItem {
  findingId: string;
  roomId: string;
  roomName: string;
  title: string;
  priority: AuditPriority;
  severity: Finding['severity'];
  /** Why it sits where it does, in words a technician can act on. */
  reason: string;
  /** True when the AI was unsure enough that a human should look regardless. */
  lowConfidence: boolean;
}

/** Below this the model is guessing; the item is flagged for a human either way. */
const LOW_CONFIDENCE = 0.6;

const SEVERITY_RANK: Record<Finding['severity'], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const PRIORITY_RANK: Record<AuditPriority, number> = { ACT_NOW: 0, REVIEW: 1, MONITOR: 2 };

/**
 * Where one finding belongs in the technician's queue of attention.
 *
 * Deliberately does not encode responsibility or cost. Those are administrator
 * determinations, and a technician-facing priority that implied "the tenant
 * pays for this" would be the app pre-judging a decision it is not allowed to
 * make.
 */
function classify(finding: Finding): { priority: AuditPriority; reason: string } {
  if (finding.comparisonResult === 'MISSING_EVIDENCE')
    return { priority: 'ACT_NOW', reason: 'Evidence missing — recapture before leaving' };
  if (finding.comparisonResult === 'INSUFFICIENT_DATA')
    return { priority: 'ACT_NOW', reason: 'Not enough footage to judge — recapture this area' };
  if (finding.comparisonResult === 'POSSIBLE_NEW_DAMAGE' && finding.severity === 'HIGH')
    return { priority: 'ACT_NOW', reason: 'Possible new damage, high severity' };
  if (finding.comparisonResult === 'POSSIBLE_NEW_DAMAGE')
    return { priority: 'REVIEW', reason: 'Possible new damage — confirm the evidence covers it' };
  if (finding.severity === 'HIGH')
    return { priority: 'REVIEW', reason: 'High severity — make sure it is clearly captured' };
  if (finding.comparisonResult === 'OWNER_MAINTENANCE')
    return { priority: 'REVIEW', reason: 'Maintenance item for the owner' };
  return { priority: 'MONITOR', reason: 'Existing or expected condition' };
}

/**
 * The audit, ordered by what needs attention first.
 *
 * Room summaries are excluded: they are narrative context for reviewers, not
 * findings, and listing them as action items would bury the real ones. See
 * `isRoomSummary`.
 */
export function buildPriorityChecklist(findings: readonly Finding[]): PriorityItem[] {
  return findings
    .filter((finding) => !isRoomSummary(finding))
    .map((finding) => {
      const { priority, reason } = classify(finding);
      const lowConfidence = finding.confidence < LOW_CONFIDENCE;
      return {
        findingId: finding.id,
        roomId: finding.roomId,
        roomName: finding.roomName,
        title: finding.title,
        priority,
        severity: finding.severity,
        // A low-confidence read is worth saying out loud: the technician is
        // standing in the room and can settle it in seconds.
        reason: lowConfidence ? `${reason} · AI unsure` : reason,
        lowConfidence,
      };
    })
    .sort(
      (left, right) =>
        PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
        left.roomName.localeCompare(right.roomName),
    );
}

export interface AreaSummaryCoverage {
  roomId: string;
  roomName: string;
  hasSummary: boolean;
  findingCount: number;
}

export interface SummaryCoverage {
  areas: AreaSummaryCoverage[];
  /** Finished areas the AI produced no summary for — the gap worth chasing. */
  missing: AreaSummaryCoverage[];
  covered: number;
  total: number;
}

/**
 * Which finished areas actually got an AI summary.
 *
 * The pipeline is best-effort per recording: transcription or analysis can fail
 * for one area while every other one succeeds, and nothing surfaced that. An
 * inspection could reach review with a silent hole in it — a room whose video
 * uploaded, processed, and produced nothing, indistinguishable on screen from a
 * room the AI simply had nothing to say about.
 *
 * Only areas that finished are counted. An area still being worked has no
 * summary yet for the ordinary reason.
 */
export function summaryCoverage(
  rooms: readonly InspectionRoom[],
  findings: readonly Finding[],
): SummaryCoverage {
  const summaryRoomIds = new Set(
    findings.filter((finding) => isRoomSummary(finding)).map((finding) => finding.roomId),
  );
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    if (isRoomSummary(finding)) continue;
    findingCounts.set(finding.roomId, (findingCounts.get(finding.roomId) ?? 0) + 1);
  }

  const areas = rooms
    // Skipped areas are a deliberate decision with a recorded reason, not a
    // gap: there is no video, so there is nothing to summarise.
    .filter((room) => room.completionStatus === 'COMPLETED')
    .map((room) => ({
      roomId: room.id,
      roomName: room.name,
      hasSummary: summaryRoomIds.has(room.id),
      findingCount: findingCounts.get(room.id) ?? 0,
    }));

  return {
    areas,
    missing: areas.filter((area) => !area.hasSummary),
    covered: areas.filter((area) => area.hasSummary).length,
    total: areas.length,
  };
}

/** The one-line count for a per-priority header. */
export function countByPriority(items: readonly PriorityItem[]) {
  return {
    actNow: items.filter((item) => item.priority === 'ACT_NOW').length,
    review: items.filter((item) => item.priority === 'REVIEW').length,
    monitor: items.filter((item) => item.priority === 'MONITOR').length,
  };
}
