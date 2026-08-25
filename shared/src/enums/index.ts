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
  TECHNICIAN_SUBMITTED = 'TECHNICIAN_SUBMITTED',
  PROCESSING = 'PROCESSING',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  UNDER_REVIEW = 'UNDER_REVIEW',
  TBD = 'TBD',
  FOLLOW_UP_REQUIRED = 'FOLLOW_UP_REQUIRED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}
export const InspectionType = {
  MOVE_IN: 'MOVE_IN',
  OCCUPIED: 'OCCUPIED',
  BACK_TO_MARKET: 'BACK_TO_MARKET',
  MOVE_OUT: 'MOVE_OUT',
  /**
   * Equipment maintenance, not a tenancy lifecycle stage. Deliberately outside
   * the MOVE_IN -> OCCUPIED -> BACK_TO_MARKET -> MOVE_OUT chain: HVAC is checked
   * on a schedule of its own, on tenanted and vacant properties alike.
   */
  HVAC: 'HVAC',
  /**
   * Off-cycle work, all of it outside the tenancy chain for the same reason
   * HVAC is: none of these is a stage a tenancy passes through, and none of
   * them is compared against a move-in.
   *
   * They differ from the five above in what they cover. A roof inspection and
   * a filter delivery are scoped by the property itself — the areas recorded
   * as a roof, or as holding an air conditioner — so the office cannot forget
   * one and cannot send a technician looking for something that was never
   * there. The two lockbox visits have no fixed subject, so the office says
   * which area the box goes on.
   */
  ROOF: 'ROOF',
  SUPRA_LOCKBOX_PLACEMENT: 'SUPRA_LOCKBOX_PLACEMENT',
  SUPRA_LOCKBOX_REMOVAL: 'SUPRA_LOCKBOX_REMOVAL',
  AC_FILTER_DELIVERY: 'AC_FILTER_DELIVERY',
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
