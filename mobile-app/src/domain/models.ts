import type { InspectionType } from '@texasrenters/shared';

export type DemoRole = 'TECHNICIAN' | 'REVIEWER' | 'ADMINISTRATOR';
export type InspectionStatus =
  'SCHEDULED' | 'IN_PROGRESS' | 'PROCESSING' | 'REVIEW_REQUIRED' | 'COMPLETED' | 'CANCELLED';
export type Priority = 'STANDARD' | 'HIGH';
export type RoomCompletionStatus = 'NOT_STARTED' | 'RECORDING_SAVED' | 'COMPLETED' | 'SKIPPED';
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

export interface InspectionRoom {
  id: string;
  inspectionId: string;
  propertyAreaId: string;
  name: string;
  floorName: string;
  order: number;
  isRequired: boolean;
  inspectionType: InspectionType;
  baseline: BaselineCondition;
  completionStatus: RoomCompletionStatus;
  uploadStatus: UploadStatus;
  processingStatus: ProcessingStatus;
  reviewStatus?: FindingStatus;
  note?: string;
  skipReason?: string;
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
  scheduledAt: string;
  assignedUserId: string;
  status: InspectionStatus;
  priority: Priority;
  roomIds: string[];
  propertyNotes: string;
  property: Pick<Property, 'id' | 'address' | 'cityStateZip' | 'imageTone'>;
  progress: { completed: number; total: number; hasFailedUpload: boolean };
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
    pendingReviewCount: number;
  };
}

export interface LocalMedia {
  id: string;
  ownerUserId?: string;
  inspectionId: string;
  roomId: string;
  propertyAddress?: string;
  roomName?: string;
  uri: string;
  durationSeconds: number;
  estimatedSizeMb: number;
  recordedAt: string;
  note: string;
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
}

export interface UploadItem {
  id: string;
  ownerUserId?: string;
  mediaId: string;
  inspectionId: string;
  roomId: string;
  propertyAddress: string;
  roomName: string;
  durationSeconds: number;
  estimatedSizeMb: number;
  status: UploadStatus;
  progress: number;
  lastError?: string;
  attemptCount?: number;
  nextAttemptAt?: string;
  processingStatus: ProcessingStatus;
  processingProgress: number;
  createdAt: string;
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
}

export interface DashboardSummary {
  today: number;
  inProgress: number;
  completed: number;
  pendingUploads: number;
  assignments: Inspection[];
  recent: Inspection[];
}
