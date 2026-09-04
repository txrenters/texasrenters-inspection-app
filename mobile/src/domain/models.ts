import type { EntitySyncMetadata, InspectionType } from '@texasrenters/shared';
import type { GuidedCaptureSummary, SnapshotCaptureSource } from '../capture/guided-capture';

export type DemoRole = 'TECHNICIAN' | 'REVIEWER' | 'ADMINISTRATOR';
export type InspectionStatus =
  | 'SCHEDULED'
  | 'IN_PROGRESS'
  | 'TECHNICIAN_SUBMITTED'
  | 'PROCESSING'
  | 'REVIEW_REQUIRED'
  | 'UNDER_REVIEW'
  | 'TBD'
  | 'FOLLOW_UP_REQUIRED'
  | 'COMPLETED'
  | 'CANCELLED';
export type Priority = 'STANDARD' | 'HIGH';
export type RoomCompletionStatus =
  'NOT_STARTED' | 'RECORDING_SAVED' | 'UPLOADED' | 'COMPLETED' | 'SKIPPED' | 'FAILED';
export type UploadStatus = 'PENDING' | 'UPLOADING' | 'PAUSED' | 'FAILED' | 'COMPLETED';
export type ProcessingStatus =
  | 'NOT_STARTED'
  | 'VIDEO_PROCESSING'
  | 'TRANSCRIBING'
  | 'ANALYZING'
  | 'COMPARING_BASELINE'
  | 'PREPARING_FINDINGS'
  | 'READY_FOR_REVIEW'
  | 'FAILED';
export type FindingStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'EDITED' | 'REJECTED' | 'REINSPECTION_REQUESTED';

export interface DemoUser {
  id: string;
  name: string;
  initials: string;
  role: DemoRole;
  roleLabel: string;
  mustChangePassword?: boolean;
}

export interface Property {
  id: string;
  externalPropertyId: string;
  externalOwnerId: string;
  externalPortfolioId: string;
  name: string;
  address: string;
  unitName?: string | null;
  cityStateZip: string;
  bedrooms: number;
  bathrooms: number;
  floors: string[];
  accessInstructions: string;
  notes: string;
  imageTone: 'teal' | 'navy' | 'sand' | 'sage';
}

export interface FloorPlanContentSource {
  uri: string;
  headers: { authorization: string };
}

export interface FloorPlanDocument {
  id: string;
  fileName: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  status: 'APPROVED';
  createdAt: string;
  contentSources: FloorPlanContentSource[];
}

export interface PortfolioSummary {
  id: string;
  externalId: string;
  name: string;
  abbreviation?: string;
}

export interface UnitSummary {
  id: string;
  externalId: string;
  propertyExternalId: string;
  name: string;
  bedrooms?: number;
  bathrooms?: number;
}

export interface LeaseSummary {
  id: string;
  externalId: string;
  unitExternalId: string;
  status: string;
  scheduledMoveOutDate?: string;
}

export interface BaselineCondition {
  summary: string;
  condition: 'DOCUMENTED' | 'LIMITED' | 'NOT_AVAILABLE';
  existingDefects: string[];
  evidenceCount: number;
}

export type AreaEnvironment = 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';
export type AreaApprovalStatus = 'DRAFT' | 'APPROVED' | 'REJECTED';

export interface InspectionRoom {
  id: string;
  inspectionId: string;
  propertyAreaId: string;
  name: string;
  floorName: string;
  order: number;
  isRequired: boolean;
  inspectionType: InspectionType;
  /**
   * The move-in condition this area is judged against.
   *
   * Absent on a visit that does not deal in baselines. That is a different
   * statement from a baseline whose condition is NOT_AVAILABLE: an HVAC visit
   * sits outside the move-in chain entirely, so the question does not apply and
   * the screen shows nothing rather than warning about a missing record.
   */
  baseline?: BaselineCondition;
  completionStatus: RoomCompletionStatus;
  uploadStatus: UploadStatus;
  processingStatus: ProcessingStatus;
  reviewStatus?: FindingStatus;
  note?: string;
  skipReason?: string;
  /**
   * When the technician attested that the AI summary matches what they saw.
   * Undefined means unconfirmed — including on areas that have no summary yet,
   * which are not awaiting anything.
   */
  summaryConfirmedAt?: string;
  /**
   * A summary is still on its way for this area. Server-computed, because
   * `processingStatus` cannot express it — PENDING and "no recording" both
   * arrive as NOT_STARTED.
   */
  analysisPending?: boolean;
  // Area classification and provenance (Phase 2). Optional so pre-Phase-2 mock
  // data stays valid; the API always populates them (schema defaults).
  environment?: AreaEnvironment;
  category?: string | null;
  source?: string; // AI_FLOOR_PLAN | MANUAL | MANUAL_FALLBACK | TECHNICIAN
  areaStatus?: AreaApprovalStatus; // DRAFT technician areas await admin approval
  updatedAt?: string;
  __sync?: EntitySyncMetadata;
}

export interface Inspection {
  id: string;
  externalInspectionId: string;
  propertyId: string;
  unitId?: string | null;
  unitName?: string | null;
  type: InspectionType;
  baselineInspectionId?: string | null;
  baselineScheduledAt?: string;
  /** The day the visit is booked for. Always present. */
  scheduledAt: string;
  /**
   * The clock window, when the office scheduled one in Jobber.
   *
   * Absent — not midnight — for anything booked without a time. The distinction
   * matters on screen: a technician told "12:00 AM" would go looking for a
   * booking nobody made, so a visit with no time shows only its day.
   */
  scheduledStartAt?: string;
  scheduledEndAt?: string;
  assignedUserId: string;
  status: InspectionStatus;
  priority: Priority;
  roomIds: string[];
  /**
   * The administrator scheduled this without an approved floor plan and asked
   * the technician to survey the areas. An empty area list is then the expected
   * starting point, not a fault.
   */
  allowTechnicianAreaCapture: boolean;
  /**
   * Why the office sent this inspection back.
   *
   * Set when an administrator reopens it, cleared when the technician submits
   * again. Undefined on an inspection that was never reopened.
   */
  reopenReason?: string;
  propertyNotes: string;
  property: Pick<Property, 'id' | 'address' | 'cityStateZip' | 'imageTone'>;
  progress: { completed: number; total: number; hasFailedUpload: boolean };
  updatedAt?: string;
  __sync?: EntitySyncMetadata;
}

export interface InspectionContext {
  inspection: Inspection;
  property: Property;
  rooms: InspectionRoom[];
  pendingReviewCount: number;
}

export interface InspectionReportFinding {
  id: string;
  findingType: 'POSSIBLE_NEW_DAMAGE' | 'EXISTING_CONDITION' | 'MAINTENANCE' | 'NO_CHANGE';
  title: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  comparisonResult: string;
  confidence: number;
  description: string;
  recommendedReview: string;
  reviewStatus: FindingStatus;
}

export interface InspectionReportRoom extends InspectionRoom {
  /** Server-side photo count. Not the device's local snapshot store. */
  photoCount: number;
  summary: string | null;
  findings: InspectionReportFinding[];
}

export interface InspectionReport {
  inspection: Inspection;
  property: Property;
  generatedAt: string;
  rooms: InspectionReportRoom[];
  totals: {
    rooms: number;
    finishedRooms: number;
    summaries: number;
    defectFindings: number;
    photos: number;
    pendingReviewCount: number;
  };
}

export type VideoRecordingType = 'PRIMARY_AREA' | 'ADDITIONAL_ISSUE';

export type AdditionalVideoCategory =
  | 'ADDITIONAL_DAMAGE'
  | 'APPLIANCE_TEST'
  | 'PLUMBING'
  | 'ELECTRICAL'
  | 'PEST'
  | 'PET_EVIDENCE'
  | 'SAFETY'
  | 'EXTERIOR'
  | 'FOLLOW_UP'
  | 'REINSPECTION'
  | 'OTHER';

export interface LocalMedia {
  id: string;
  ownerUserId?: string;
  inspectionId: string;
  roomId: string;
  // Primary walkthrough by default; additional labeled clips carry their own
  // label/category and never replace the primary video for the area.
  recordingType?: VideoRecordingType;
  label?: string;
  category?: AdditionalVideoCategory;
  relatedFindingId?: string;
  propertyAddress?: string;
  roomName?: string;
  uri: string;
  durationSeconds: number;
  estimatedSizeMb: number;
  recordedAt: string;
  note: string;
  captureSummary?: GuidedCaptureSummary;
  /**
   * The capture session that produced this take.
   *
   * Snapshots carry the same id. Without it the review screen cannot tell
   * which photographs belong to the recording in front of it, which is how
   * discarding a take used to leave its photographs behind — including the
   * copies already uploaded, which then appeared in the report for a
   * walkthrough that was thrown away.
   */
  recordingSessionId?: string;
  /**
   * Video offsets, in milliseconds, where the technician asked for a still.
   *
   * Android cannot photograph while recording — expo-camera binds either the
   * image or the video use case, never both — so the shutter records the moment
   * instead of interrupting the walkthrough, and the server cuts those frames
   * out of the uploaded video afterwards.
   */
  frameMarkersMs?: number[];
}

export type PhotoCaptureType =
  | 'AREA_OVERVIEW'
  | 'WALL_OVERVIEW'
  | 'FINDING_CONTEXT'
  | 'FINDING_CLOSE_UP'
  | 'SUPPORTING_ANGLE'
  | 'SCALE_REFERENCE'
  | 'SERIAL_OR_LABEL'
  | 'VIDEO_FRAME_SNAPSHOT'
  | 'OTHER'
  // Retained so offline drafts created by earlier releases still deserialize.
  | 'FINDING_DETAIL'
  | 'SUPPORTING_EVIDENCE';
export type PhotoUploadStatus = 'PENDING' | 'UPLOADING' | 'UPLOADED' | 'FAILED';

/** A photo the server holds for an area — server truth, not a local draft. */
export interface RoomPhoto {
  id: string;
  roomId: string;
  findingId: string | null;
  captureType: PhotoCaptureType;
  sequenceNumber: number | null;
  label: string | null;
  capturedAt: string;
  /** Authenticated path; not directly loadable without the bearer token. */
  contentPath: string;
}

export interface RoomSnapshot {
  id: string;
  ownerUserId?: string;
  inspectionId: string;
  roomId: string;
  uri: string;
  width: number;
  height: number;
  sizeBytes?: number;
  capturedAt: string;
  captureType?: PhotoCaptureType;
  recordingSessionId?: string;
  videoTimestampMs?: number;
  captureSource?: SnapshotCaptureSource;
  sequenceNumber?: number;
  findingId?: string;
  uploadStatus?: PhotoUploadStatus;
  serverPhotoId?: string;
  /**
   * Why the last upload attempt failed, and when to try again.
   *
   * A photo used to fail into silence: a bare catch marked it FAILED, the
   * JPEG stayed on the device, and nothing re-sent it or said so. These three
   * are what let it be retried and, when it genuinely cannot be, explained.
   */
  lastError?: string;
  attempts?: number;
  /** ISO timestamp. Absent means "due now". */
  nextAttemptAt?: string;
}

export interface UploadItem {
  id: string;
  ownerUserId?: string;
  mediaId: string;
  inspectionId: string;
  roomId: string;
  recordingType?: VideoRecordingType;
  label?: string;
  category?: AdditionalVideoCategory;
  relatedFindingId?: string;
  propertyAddress: string;
  roomName: string;
  durationSeconds: number;
  estimatedSizeMb: number;
  status: UploadStatus;
  progress: number;
  lastError?: string;
  attemptCount?: number;
  nextAttemptAt?: string;
  // --- Cloudflare Stream resumable upload ---
  // Absent until a session exists, and absent forever on a build with no
  // Cloudflare credentials, where the multipart path still runs.
  streamUid?: string;
  serverVideoId?: string;
  uploadUrl?: string;
  uploadUrlExpiresAt?: string;
  /**
   * Bytes Cloudflare has confirmed, not bytes this device believes it sent.
   *
   * `progress` above is a percentage for display; this is what an interrupted
   * upload resumes from, which is why it is stored separately and in bytes.
   */
  uploadedBytes?: number;
  fileSize?: number;
  processingStatus: ProcessingStatus;
  processingProgress: number;
  createdAt: string;
  operationId?: string;
  __sync?: EntitySyncMetadata;
}

export interface Finding {
  id: string;
  inspectionId: string;
  roomId: string;
  roomName: string;
  title: string;
  category: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  comparisonResult:
    | 'POSSIBLE_NEW_DAMAGE'
    | 'EXISTING_CONDITION'
    | 'NO_MATERIAL_CHANGE'
    | 'NORMAL_WEAR'
    | 'OWNER_MAINTENANCE'
    | 'MISSING_EVIDENCE'
    | 'INSUFFICIENT_DATA';
  confidence: number;
  videoTimestampStart: number;
  videoTimestampEnd: number;
  baselineCondition: string;
  observation: string;
  aiSummary: string;
  recommendedReview: string;
  reviewStatus: FindingStatus;
  reviewerNotes?: string;
  updatedAt?: string;
  __sync?: EntitySyncMetadata;
}

export interface DashboardSummary {
  today: number;
  inProgress: number;
  completed: number;
  pendingUploads: number;
  assignments: Inspection[];
  recent: Inspection[];
}

/**
 * How one checklist item was found, as the printed report scores it.
 *
 * Every axis is a **tri-state**: true, false, or null for "not assessed".
 * The office's reports leave such cells blank, and treating null as false
 * would publish a defect the technician never observed.
 */
export interface ChecklistAssessment {
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment: string | null;
  /**
   * Seconds into the area's recording when this was answered.
   *
   * Set when the prompt is answered during capture, so a reviewer can jump to
   * the moment rather than scrubbing. Null when scored outside a recording.
   */
  videoTimestampSeconds?: number | null;
  /**
   * A measurement, for a READING item.
   *
   * The HVAC form asks for eight of them and a temperature split is the
   * diagnosis, not a note. Recorded as a number so it can be compared between
   * visits rather than read out of a comment.
   */
  numericValue?: number | null;
  /** Free text for a TEXT item, or the chosen option for a CHOICE one. */
  textValue?: string | null;
}

/** A checklist item together with this inspection's assessment of it. */
/** How one checklist item is answered. Mirrors the server's enum. */
export type ChecklistResponseType = 'STATUS' | 'READING' | 'TEXT' | 'CHOICE';

export interface ChecklistItemWithAssessment extends ChecklistAssessment {
  id: string;
  label: string;
  keywords: string[];
  /** The printed section heading, for grouping. Null on room checklists. */
  section?: string | null;
  /** Absent on anything the server has not upgraded yet; treated as STATUS. */
  responseType?: ChecklistResponseType;
  /** READING only, shown beside the field so nobody guesses Celsius. */
  unit?: string | null;
  /** CHOICE only. */
  choices?: string[];
  /** When it was scored; null while unassessed. */
  recordedAt: string | null;
}

/**
 * The office asking for more evidence in one area.
 *
 * `items` empty means the whole area rather than nothing — that is how a
 * reviewer asks for a re-walk instead of one detail.
 */
export interface EvidenceRequest {
  id: string;
  roomId: string;
  roomName: string;
  note: string;
  requestedAt: string;
  items: string[];
}

/**
 * An open request seen from outside any one inspection.
 *
 * Carries the property, because this is read from a tab: an area name alone
 * does not tell a technician which building to drive to.
 */
export interface OpenEvidenceRequest {
  id: string;
  inspectionId: string;
  roomId: string;
  roomName: string;
  propertyName: string;
  unitName: string | null;
  note: string;
  requestedAt: string;
}
