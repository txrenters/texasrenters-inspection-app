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
  /** Capture began or was skipped, but the required evidence is not all there. */
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
  completionStatus: string;
  reviewStatus: AreaReviewStatus;
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
  counts: AreaEvidenceCounts;
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
