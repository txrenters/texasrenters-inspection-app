/**
 * Area-first inspection evidence.
 *
 * The review screen is organised by inspection area, not by media type: every
 * recording, photo, condition summary and finding belongs to exactly one area
 * and is read through that area. Two queries back it —
 *
 *  1. a summary of every area, carrying counts and status but **no media**, and
 *  2. an evidence bundle for the one area the reviewer opened.
 *
 * Keeping media out of (1) is the point: the old screen fetched every
 * recording, every photo and every finding for the whole inspection up front.
 */

/**
 * Where an area stands in the capture → analysis → review pipeline.
 *
 * Derived on read from the area's completion status, its media processing
 * states and its findings' review states — never stored. A stored copy would
 * drift the moment a finding was approved or a video finished processing.
 */
export type AreaReviewStatus =
  /** Nothing captured yet. */
  | 'NOT_STARTED'
  /**
   * The technician deliberately skipped this area and gave a reason.
   *
   * Distinct from EVIDENCE_INCOMPLETE, which it used to be folded into. The two
   * look identical on a dashboard and mean opposite things: incomplete is work
   * that stopped halfway, skipped is a decision someone made and can justify —
   * a locked room, a tenant who refused access. Showing "Evidence incomplete"
   * over a reason the technician typed reads as if the app ignored them, and it
   * sends a reviewer chasing evidence that was never going to exist.
   */
  | 'SKIPPED'
  /** Capture began, but the required evidence is not all there. */
  | 'EVIDENCE_INCOMPLETE'
  /** Evidence is present and nothing needs a decision. */
  | 'EVIDENCE_READY'
  /** Media is still transcribing or being analysed. */
  | 'ANALYSIS_PROCESSING'
  /** At least one finding is awaiting a human decision. */
  | 'FINDINGS_NEED_REVIEW'
  /** Evidence present and every finding has been decided. */
  | 'REVIEWED'
  /** A reviewer asked for re-inspection of something in this area. */
  | 'FOLLOW_UP_REQUIRED'
  /** Media processing failed; the evidence cannot be analysed as it stands. */
  | 'FAILED';

export interface AreaEvidenceCounts {
  recordings: number;
  photos: number;
  findings: number;
  unreviewedFindings: number;
}

/** Presence flags a reviewer needs before deciding whether to open an area. */
export interface AreaEvidenceFlags {
  primaryRecordingAvailable: boolean;
  overviewPhotoAvailable: boolean;
  conditionSummaryAvailable: boolean;
}

export interface AreaEvidenceSummaryItem {
  /** InspectionArea id — the id every media row points at. */
  id: string;
  /** Catalog PropertyArea id — what findings are keyed by. */
  propertyAreaId: string;
  name: string;
  floorName?: string | null;
  environment: 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';
  isRequired: boolean;
  /**
   * Administrator-authored checklist items for this area, excluding archived
   * ones. Zero means the technician sees a generated fallback list rather than
   * nothing, so it is a prompt to configure rather than a fault.
   */
  checklistItemCount: number;
  /**
   * Items the technician actually assessed — at least one of Clean, Undamaged
   * or Working answered.
   *
   * Counted independently of `checklistItemCount` rather than derived from it,
   * because an area can hold assessments against items an administrator has
   * since archived. The report still prints those rows, so a reviewer comparing
   * the two numbers may legitimately see assessed exceed the current item
   * count; that is a signal the checklist changed mid-inspection, not an error.
   */
  checklistAssessedCount: number;
  completionStatus: string;
  reviewStatus: AreaReviewStatus;
  /** Why the technician skipped it; null unless reviewStatus is SKIPPED. */
  skipReason?: string | null;
  counts: AreaEvidenceCounts;
  evidence: AreaEvidenceFlags;
  /** Most recent capture in this area, or null when nothing was captured. */
  lastEvidenceAt?: string | null;
}

export interface AreaEvidenceSummary {
  inspectionId: string;
  totals: AreaEvidenceCounts & { areas: number; areasReviewed: number };
  areas: AreaEvidenceSummaryItem[];
  /**
   * Media whose area link is missing. The schema requires an area on every
   * recording and photo, so this is normally empty — it exists so that a future
   * relaxation, or an import, cannot silently hide evidence.
   */
  unassigned: { recordings: number; photos: number };
}

export interface AreaRecording {
  id: string;
  recordingType: 'PRIMARY_AREA' | 'ADDITIONAL_ISSUE';
  label?: string | null;
  category?: string | null;
  durationSeconds: number;
  uploadStatus: string;
  processingStatus: string;
  technicianName: string;
  createdAt: string;
  /** Poster frame. Playback itself is requested only when opened. */
  thumbnailUrl?: string | null;
  /**
   * Offsets, in milliseconds, where the technician tapped the shutter during
   * the walkthrough.
   *
   * Android cannot photograph while recording — expo-camera binds either the
   * image or the video use case, never both — so the shutter stores a moment
   * instead of a picture. Surfacing them lets a reviewer jump straight to what
   * the technician wanted looked at, and capture the frame themselves.
   */
  frameMarkersMs: number[];
  /** Proxy fallback for storage backends that cannot sign URLs. */
  contentPath: string;
}

export interface AreaPhoto {
  id: string;
  captureType: string;
  label?: string | null;
  notes?: string | null;
  sequenceNumber: number;
  width?: number | null;
  height?: number | null;
  capturedAt: string;
  capturedByName: string;
  /** Finding this photo evidences, when it documents a specific one. */
  findingId?: string | null;
  /** Base path; callers append a width to request a bounded variant. */
  contentPath: string;
}

/** Photos split by role so finding evidence stays attached to its finding. */
export interface AreaPhotoGroup {
  key: 'OVERVIEW' | 'FINDING' | 'SUPPORTING';
  label: string;
  /** Set when the group documents one finding. */
  findingId?: string | null;
  findingTitle?: string | null;
  photos: AreaPhoto[];
}

export interface AreaConditionSummary {
  id: string;
  description: string;
  createdAt: string;
  reviewStatus: string;
}

export interface AreaEvidenceBundle {
  area: {
    id: string;
    propertyAreaId: string;
    name: string;
    floorName?: string | null;
    environment: string;
    isRequired: boolean;
    completionStatus: string;
    reviewStatus: AreaReviewStatus;
    skipReason?: string | null;
    technicianNote?: string | null;
  };
  /** Overall narrative for the area; supporting context, not a substitute for findings. */
  conditionSummary?: AreaConditionSummary | null;
  recordings: AreaRecording[];
  photoGroups: AreaPhotoGroup[];
  /** Itemized findings for this area, most severe first. */
  findings: AreaFinding[];
  /**
   * The area's checklist with however it has been assessed, in walk order.
   *
   * Scored during review rather than on site: the reviewer is the one reading
   * the recording and the photographs, and each axis is a judgement about
   * evidence they are already looking at.
   */
  checklist: AreaChecklistEntry[];
  counts: AreaEvidenceCounts;
}

/**
 * One checklist item and its assessment.
 *
 * Each axis is `true`, `false`, or `null` for not assessed. Null is not the same
 * as "no": the report prints those cells blank precisely so a skipped item
 * cannot be read as a fault.
 */
export interface AreaChecklistEntry {
  itemId: string;
  label: string;
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment: string | null;
  recordedAt: string | null;
  /**
   * Seconds into the area's recording when this was answered, so a reviewer can
   * jump to the moment instead of scrubbing. Null when the assessment was made
   * outside a recording — on the web, or after the fact.
   */
  videoTimestampSeconds: number | null;
  /**
   * The printed section heading this item sits under, for grouping a long form
   * on screen. Null on a room checklist, which is a flat list per area.
   */
  section?: string | null;
  /**
   * How the item is answered. Absent means STATUS — every room checklist, and
   * anything recorded before the HVAC form arrived.
   */
  responseType?: 'STATUS' | 'READING' | 'TEXT' | 'CHOICE';
  /** READING only: the unit the measurement was taken in. */
  unit?: string | null;
  /** READING only: what was measured. */
  numericValue?: number | null;
  /** TEXT and CHOICE: the line written, or the option chosen. */
  textValue?: string | null;
}

/**
 * One reviewable finding. Estimate fields are optional and arrive only for
 * viewers permitted to see them; a finding's review state and the state of any
 * proposed amount are deliberately independent.
 */
export interface AreaFinding {
  id: string;
  title: string;
  description: string;
  category: string;
  findingType: string;
  severity: string;
  comparisonResult: string;
  baselineCondition?: string | null;
  confidence: number;
  reviewStatus: string;
  createdAt: string;
  /** Recording this finding was observed in, with its moment. */
  recordingId?: string | null;
  videoTimestampStart: number;
  videoTimestampEnd: number;
  photoCount: number;
  lastReview?: {
    status: string;
    reason?: string | null;
    reviewerName: string;
    createdAt: string;
  } | null;
}

/**
 * A reviewer's request for more evidence in one area.
 *
 * `checklistItemIds` empty means the whole area rather than nothing — that is
 * how a reviewer asks for a re-walk instead of one detail.
 */
export interface AdminEvidenceRequest {
  id: string;
  inspectionId: string;
  inspectionAreaId: string;
  checklistItemIds: string[];
  note: string;
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED';
  requestedAt: string;
  resolvedAt?: string | null;
  inspectionArea: { propertyArea: { name: string } };
}
