/**
 * How the office teaches the AI (2026-10-03): house rules for what counts as
 * damage, wear and cleaning, a reason for every rejection, corrections kept
 * beside the approval, and a scorecard of how the AI's findings fared.
 */

/** Why a finding was rejected. The AI is shown these as lessons. */
export type FindingRejectReason =
  | 'NOT_IN_VIDEO'
  | 'ALREADY_AT_MOVE_IN'
  | 'NORMAL_WEAR'
  | 'DUPLICATE'
  | 'WRONG_ROOM'
  | 'NOT_A_PROBLEM'
  | 'OTHER';

/** In the order a reviewer is offered them, most common first. */
export const FINDING_REJECT_REASONS: ReadonlyArray<{
  code: FindingRejectReason;
  label: string;
}> = [
  { code: 'NORMAL_WEAR', label: 'Normal wear' },
  { code: 'ALREADY_AT_MOVE_IN', label: 'Already at move-in' },
  { code: 'NOT_IN_VIDEO', label: 'Not in the video' },
  { code: 'NOT_A_PROBLEM', label: 'Not a problem' },
  { code: 'DUPLICATE', label: 'Duplicate' },
  { code: 'WRONG_ROOM', label: 'Wrong room' },
  { code: 'OTHER', label: 'Other' },
];

export function rejectReasonLabel(code: string | null | undefined) {
  return FINDING_REJECT_REASONS.find((reason) => reason.code === code)?.label ?? null;
}

/** As the database allows. */
export const MAX_AI_GUIDANCE_LENGTH = 8000;

export interface AiGuidanceHistory {
  /** The rules in use. Version 0 and empty text when none were ever written. */
  current: { version: number; text: string };
  /** Newest first, at most twenty. */
  versions: Array<{
    version: number;
    createdAt: string;
    createdByName: string | null;
    length: number;
  }>;
}

export interface AiGuidanceSaveResult extends AiGuidanceHistory {
  /** The version now in use; the same one when the text did not change. */
  saved: { version: number; text: string };
}

/** A recording the office has decided findings on, to try draft rules against. */
export interface AiGuidanceSample {
  mediaId: string;
  inspectionId: string;
  roomName: string;
  propertyName: string | null;
  inspectionType: string;
  recordedAt: string;
  findings: number;
}

export interface AiPreviewFinding {
  title: string;
  description: string;
  severity: string;
  findingType: string;
  category: string;
  comparisonResult: string;
  possibleResponsibility: string;
  confidence: number;
  videoTimestampStart: number;
  videoTimestampEnd: number;
}

/** What the analysis would say under draft rules, beside what it said and what was decided. */
export interface AiAnalysisPreview {
  mediaId: string;
  inspectionId: string;
  roomName: string;
  modelId: string;
  tokens: number;
  /** The draft's room summary, which is context rather than a finding. */
  summary: string | null;
  /** Findings only: the room summary is left out of both lists. */
  draft: AiPreviewFinding[];
  current: Array<{
    id: string;
    title: string;
    description: string;
    severity: string;
    findingType: string;
    category: string;
    source: 'NARRATION' | 'AI_VISION';
    reviewStatus: string;
    videoTimestampStart: number;
    videoTimestampEnd: number;
    lastReview: {
      status: string;
      reason: string | null;
      reasonCode: FindingRejectReason | null;
    } | null;
  }>;
}

export interface AiScoreTally {
  findings: number;
  pending: number;
  /** Approved as the AI wrote it. */
  kept: number;
  /** Approved with the office's corrections. */
  corrected: number;
  rejected: number;
}

export interface AiScorecard {
  window: { days: number; since: string; truncated: boolean };
  totals: AiScoreTally;
  bySource: Partial<Record<'NARRATION' | 'AI_VISION', AiScoreTally>>;
  /** Rejections by reason; UNSPECIFIED for those made before reasons were asked. */
  rejectReasons: Partial<Record<FindingRejectReason | 'UNSPECIFIED', number>>;
  /** What the AI saw in the video, against what the office then decided. */
  visual: {
    checked: number;
    seen: number;
    notSeen: number;
    unclear: number;
    notSeenRejected: number;
    notSeenKept: number;
    seenRejected: number;
  };
  /** Findings the AI offered a frame for, and what became of them. */
  photos: { offered: number; accepted: number; allDismissed: number };
  /** Narrated findings, and how many cite a moment in the recording. */
  timing: { narration: number; withMoment: number };
  /** By the prompt, model and house rules version that wrote the findings. */
  byVersion: Array<
    AiScoreTally & { promptVersion: string; modelId: string; guidanceVersion: number | null }
  >;
}

/** A finding as the office would have written it, approved in one step. */
export interface FindingEditInput {
  title: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  findingType: 'POSSIBLE_NEW_DAMAGE' | 'EXISTING_CONDITION' | 'MAINTENANCE' | 'NO_CHANGE';
  category: string;
  note?: string;
}

/**
 * A test run: the AI's analysis on the recent recordings the office decided,
 * under the rules tried, scored against those decisions (2026-10-03).
 */
export type AiEvaluationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface AiEvaluationTotals {
  recordings: number;
  /** Recordings the analysis could not run on. */
  failed: number;
  /** Findings the office kept, and how many the run found again. */
  kept: number;
  found: number;
  /** Findings the office rejected, and how many the run raised again. */
  rejected: number;
  repeated: number;
  /** Findings the office never decided either way. */
  added: number;
  /** Found findings with a moment a reviewer confirmed, and how many the run placed within 5 seconds. */
  timed: number;
  onTime: number;
}

export interface AiEvaluationRunSummary {
  id: string;
  status: AiEvaluationStatus;
  error: string | null;
  /** The saved version tried, or null for a draft. */
  guidanceVersion: number | null;
  houseRulesLength: number;
  promptVersion: string;
  modelId: string | null;
  recordingCount: number;
  completedCount: number;
  totals: AiEvaluationTotals | null;
  tokens: number;
  startedAt: string;
  completedAt: string | null;
  startedByName: string | null;
}

export interface AiEvaluationRecordingResult {
  mediaId: string;
  inspectionId: string;
  roomName: string;
  propertyName: string | null;
  inspectionType: string;
  recordedAt: string;
  score: {
    kept: number;
    found: number;
    missed: Array<{ id: string; title: string }>;
    rejected: number;
    repeated: Array<{ id: string; title: string; reasonCode: string | null }>;
    added: Array<{ title: string }>;
    timed: number;
    onTime: number;
  } | null;
  error: string | null;
  tokens: number;
}

export interface AiEvaluationRun extends AiEvaluationRunSummary {
  /** The rules as they were tried. */
  houseRules: string;
  results: AiEvaluationRecordingResult[];
}
