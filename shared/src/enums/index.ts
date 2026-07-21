export enum UserRole {
  SYSTEM_ADMIN = 'SYSTEM_ADMIN',
  PROPERTY_ADMIN = 'PROPERTY_ADMIN',
  INSPECTION_SUPERVISOR = 'INSPECTION_SUPERVISOR',
  INSPECTION_TECHNICIAN = 'INSPECTION_TECHNICIAN',
  CONDITION_REVIEWER = 'CONDITION_REVIEWER',
  CHARGE_APPROVER = 'CHARGE_APPROVER',
  PROPERTY_OWNER_READ_ONLY = 'PROPERTY_OWNER_READ_ONLY',
}

export enum PropertyAreaStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}
export enum InspectionStatus {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  PROCESSING = 'PROCESSING',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}
export const InspectionType = {
  MOVE_IN: 'MOVE_IN',
  OCCUPIED: 'OCCUPIED',
  BACK_TO_MARKET: 'BACK_TO_MARKET',
  MOVE_OUT: 'MOVE_OUT',
} as const;
export type InspectionType = (typeof InspectionType)[keyof typeof InspectionType];
export enum UploadQueueStatus {
  PENDING = 'PENDING',
  UPLOADING = 'UPLOADING',
  PAUSED = 'PAUSED',
  FAILED = 'FAILED',
  COMPLETED = 'COMPLETED',
}
export enum FindingReviewStatus {
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  EDITED = 'EDITED',
  REJECTED = 'REJECTED',
  REINSPECTION_REQUESTED = 'REINSPECTION_REQUESTED',
}
export enum ComparisonResult {
  EXISTING_CONDITION = 'existing_condition',
  POSSIBLE_NEW_DAMAGE = 'possible_new_damage',
  NO_MATERIAL_CHANGE = 'no_material_change',
  NORMAL_WEAR = 'normal_wear',
  OWNER_MAINTENANCE = 'owner_maintenance',
  MISSING_EVIDENCE = 'missing_evidence',
  INSUFFICIENT_DATA = 'insufficient_data',
}
export enum Severity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}
export enum ResponsibilityClassification {
  TENANT_REVIEW_REQUIRED = 'tenant_review_required',
  OWNER_REVIEW_REQUIRED = 'owner_review_required',
  UNDETERMINED = 'undetermined',
}
