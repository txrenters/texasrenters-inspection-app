import type { InspectionType } from '../enums/index.js';

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminProfile {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  memberships: Array<{ role: string; organization: { id: string; name: string } }>;
  // Effective permissions for the resolved organization. Except for the
  // bootstrap SYSTEM_ADMIN principal, these come only from custom roles.
  permissions: string[];
}

export interface AdminRoleSummary {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  assignedUserCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRole extends AdminRoleSummary {
  assignedUsers: Array<{ id: string; displayName: string; email: string }>;
}

export interface AdminUserRoleRef {
  id: string;
  name: string;
}

/**
 * Whether an account currently has the application open.
 *
 * Derived from a live websocket, so it means "listening right now" — not "on
 * shift". A technician whose phone has backgrounded the app reads as offline
 * while still working, which is why `lastSeenAt` travels with it: offline with
 * a recent time is a different fact from offline with none.
 */
export interface AccountPresence {
  isOnline: boolean;
  lastSeenAt: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isSystemAdmin: boolean;
  createdAt: string;
  customRoles: AdminUserRoleRef[];
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

export interface AdminUserDetail extends AdminUser {
  permissions: string[];
}

export interface CreatedUserAccount extends AdminUserDetail {
  mustChangePassword: true;
  temporaryPassword: string;
  emailDeliveryStatus: MailDeliveryStatus;
}

export interface AdminDashboard {
  metrics: {
    portfolios: number;
    properties: number;
    units: number;
    leases: number;
    unassigned: number;
    assigned: number;
    inProgress: number;
    completed: number;
    technicians: number;
  };
  lastSync: PropertywareSyncRun | null;
  recentErrors: Array<{
    id: string;
    entityType: string;
    errorCode: string;
    sanitizedMessage: string;
    createdAt: string;
  }>;
  providerReadiness: ProviderReadiness[];
}

export interface AdminPortfolio {
  id: string;
  externalId: string;
  name: string;
  abbreviation?: string | null;
  lastSyncedAt: string;
}

export type TotalAreaSource =
  'PROPERTYWARE_BUILDING' | 'PROPERTYWARE_UNITS_SUM' | 'MANUAL' | 'UNKNOWN';

export interface PropertyTotalArea {
  value: number | null;
  unit: string | null; // normalized, e.g. "sq ft"
  source: TotalAreaSource;
  derived: boolean; // true when summed from parts rather than a reported total
  updatedAt: string | null;
  label: string; // display-ready, e.g. "2,450 sq ft" or "Not provided"
}

export interface PropertyLeaseSummary {
  activeLeaseCount: number;
  scheduledMoveOutCount: number;
  vacantUnitCount: number;
  /** Active leases whose term ends within LEASE_EXPIRING_SOON_DAYS. */
  expiringSoonCount: number;
  /**
   * False when no units have synced for this property, so no lease conclusion
   * can be drawn. Absent data is not the same as a known absence of leases, and
   * the two must never read alike.
   */
  leaseDataAvailable: boolean;
  /**
   * Earliest upcoming lease end across the property's active leases, or null
   * when none has an end date. Derived from the lease term (`endDate`), which
   * is a different signal from a tenant's scheduled move-out.
   */
  nextLeaseEndDate?: string | null;
  summary: string; // compact, e.g. "3 active leases · 1 ending within 60 days · 2 vacant units"
}

export interface AdminProperty {
  id: string;
  externalId: string;
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  sourceStatus?: string | null;
  isActive: boolean;
  lastSyncedAt: string;
  /**
   * Null for a property Propertyware holds without a portfolio assignment.
   * Such a property is still fully inspectable; only the ownership grouping is
   * missing, so callers show it as unassigned rather than treating it as
   * malformed.
   */
  portfolio: { id: string; name: string; externalId: string } | null;
  totalArea?: PropertyTotalArea;
  leaseSummary?: PropertyLeaseSummary;
  _count?: { units: number; inspections: number };
  units?: AdminUnit[];
  leases?: AdminLease[];
  inspections?: AdminInspection[];
}

export interface AdminFloorPlan {
  id: string;
  propertyId: string;
  /** Null = building-level plan shared by all units; set = one unit's plan. */
  unitId?: string | null;
  unit?: { id: string; name: string } | null;
  fileName: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  status: 'UPLOADED' | 'PROCESSING' | 'REVIEW_REQUIRED' | 'APPROVED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  extractionJobs?: AdminFloorPlanExtractionJob[];
}

export interface AdminFloorPlanExtractionJob {
  id: string;
  floorPlanId: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  provider: string;
  modelId: string;
  schemaVersion: string;
  errorCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminFloorPlanExtractionSummary {
  detectedCount: number;
  createdCount: number;
  alreadyPresentCount: number;
  /** Areas whose spatial marker was missing or invalid (needs manual placement). */
  markerWarnings?: number;
}

export interface AdminFloorPlanExtractionResult {
  id: string;
  status: 'COMPLETED';
  provider: string;
  modelId: string;
  summary: AdminFloorPlanExtractionSummary;
  areas: AdminPropertyArea[];
}

/** Extraction runs outside the request; the client polls this until it settles. */
export interface AdminFloorPlanExtractionStarted {
  jobId: string;
  status: 'RUNNING';
}

export interface AdminFloorPlanExtractionJob {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  errorCode?: string | null;
  summary?: AdminFloorPlanExtractionSummary | null;
}

export type AreaEnvironment = 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';

export type MarkerSource =
  | 'AI_EXTRACTED'
  | 'DETERMINISTIC_EXTRACTED'
  | 'ADMIN_ADJUSTED'
  | 'ADMIN_PLACED'
  | 'UNKNOWN';

/** Spatial marker for an area — normalized 0..1 fractions of the source image/page. */
export interface AdminAreaMarker {
  available: true;
  x: number;
  y: number;
  source?: MarkerSource | string | null;
  confidence?: number | null;
  updatedAt?: string | null;
}

export interface AdminAreaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AdminPropertyArea {
  id: string;
  propertyId: string;
  /** Server revision used to reject stale reads and conflicting edits. */
  updatedAt: string;
  /** Null = building-level area shared by all units; set = one unit's area. */
  unitId?: string | null;
  unit?: { id: string; name: string } | null;
  name: string;
  inspectionOrder: number;
  isRequired: boolean;
  /**
   * Whether this area holds an air conditioner.
   *
   * Scheduling scope, not a condition observation: an HVAC inspection covers
   * every area where this is true. Optional on the contract because a client
   * built against an older server will not receive it, and `false` is the right
   * reading of its absence.
   */
  status: 'DRAFT' | 'APPROVED' | 'REJECTED';
  source: string;
  environment?: AreaEnvironment;
  category?: string | null;
  notes?: string | null;
  archivedAt?: string | null;
  createdBy?: { id: string; displayName: string } | null;
  floor?: { id: string; name: string; sortOrder: number } | null;
  /**
   * `checklistItems` excludes archived ones. Zero means a technician sees a
   * generated fallback list for this area rather than one an administrator
   * wrote, which is worth knowing before scheduling work against it.
   */
  _count?: { inspectionAreas: number; checklistItems?: number };
  /** The plan version these marker coordinates belong to (null = legacy/manual). */
  sourceFloorPlanId?: string | null;
  sourcePageNumber?: number | null;
  /** Null when the area has no marker for the current plan version. */
  marker?: AdminAreaMarker | null;
  boundingBox?: AdminAreaBoundingBox | null;
}

export interface AdminDeleteResult {
  id: string;
  deleted: true;
  deletedAt: string;
}

export interface AdminBulkDeleteResult {
  ids: string[];
  deleted: number;
  deletedAt: string;
}

/**
 * One reason an account cannot be deleted, with the count that makes it
 * concrete. "Cannot delete this technician" is not actionable; "42 video
 * captures, 8 approved findings" tells an administrator what they would be
 * erasing and why deactivating is the right action instead.
 */
export interface AccountDeletionBlocker {
  kind:
    | 'MEDIA_CAPTURED'
    | 'PHOTOS_CAPTURED'
    | 'FINDINGS_REVIEWED'
    | 'INSPECTIONS_FINALIZED'
    | 'REPORTS_SHARED'
    | 'WORK_ASSIGNED_TO_OTHERS';
  count: number;
  label: string;
}

/**
 * What deleting an account would destroy and what it would release, resolved
 * before anything is destroyed so the confirmation can state consequences
 * rather than ask for a leap of faith.
 */
export interface AccountDeletionPreflight {
  id: string;
  displayName: string;
  email: string;
  /** False when any blocker is present. Deactivation is always available. */
  canDelete: boolean;
  /** Evidence that must stay attributed. Non-empty means deletion is refused. */
  blockers: AccountDeletionBlocker[];
  /**
   * Given up on delete. Assignments are scheduling, not evidence: releasing
   * them returns each inspection to the unassigned pool for reassignment.
   */
  releases: {
    ongoingInspections: number;
    totalAssignments: number;
    roleAssignments: number;
    mobileDevices: number;
  };
}

export interface AccountDeletionResult extends AdminDeleteResult {
  /** Inspections handed back to the pool, so the caller can say how many. */
  releasedInspections: number;
  /**
   * False when the profile was removed but the sign-in identity outlived it —
   * the address stays claimed upstream and cannot be re-provisioned until an
   * administrator clears it.
   */
  identityRemoved: boolean;
}

export interface AdminUnit {
  id: string;
  externalId: string;
  name: string;
  isActive: boolean;
  bedrooms?: number | null;
  bathrooms?: number | null;
  lastSyncedAt: string;
  // Relevant (active) lease status for this unit, or null when none applies.
  leaseStatus?: string | null;
  scheduledMoveOutDate?: string | null;
  /** End of the lease term. Distinct from a scheduled move-out. */
  leaseEndDate?: string | null;
}

export interface AdminLease {
  id: string;
  externalId: string;
  leaseName?: string | null;
  sourceStatus?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  scheduledMoveOutDate?: string | null;
  /**
   * Last time a sync saw this lease in the Propertyware feed.
   *
   * Leases are never deactivated for being absent — the published report is a
   * view, not a full inventory — so a stale value here is the only sign that a
   * lease has stopped being confirmed.
   */
  lastSeenAt?: string | null;
}

export interface AdminAssignment {
  id: string;
  inspectionId: string;
  technicianId: string;
  assignedById: string;
  status: string;
  isCurrent: boolean;
  assignedAt: string;
  endedAt?: string | null;
  reason?: string | null;
  technician?: { id: string; displayName: string; email: string; isActive?: boolean };
  assignedBy?: { id: string; displayName: string };
  endedBy?: { id: string; displayName: string } | null;
  inspection?: AdminInspection & {
    propertywareBuilding?: Pick<
      AdminProperty,
      'id' | 'name' | 'addressLine1' | 'city' | 'state'
    > | null;
    propertywareUnit?: Pick<AdminUnit, 'id' | 'name'> | null;
  };
}

export interface AdminAssignmentListItem {
  id: string;
  inspectionId: string;
  recordType: 'ASSIGNMENT' | 'UNASSIGNED_INSPECTION';
  technicianId?: string | null;
  assignedById?: string | null;
  status: string;
  isCurrent: boolean;
  assignedAt?: string | null;
  endedAt?: string | null;
  reason?: string | null;
  technician?: { id: string; displayName: string; email: string; isActive?: boolean } | null;
  assignedBy?: { id: string; displayName: string } | null;
  inspection?: AdminInspection & {
    propertywareBuilding?: Pick<
      AdminProperty,
      'id' | 'name' | 'addressLine1' | 'city' | 'state'
    > | null;
    propertywareUnit?: Pick<AdminUnit, 'id' | 'name'> | null;
  };
}

export type AdminInspectionStatus =
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

export interface AdminInspection {
  id: string;
  status: AdminInspectionStatus;
  inspectionType: InspectionType;
  baselineInspectionId?: string | null;
  baselineInspection?: {
    id: string;
    inspectionType: InspectionType;
    scheduledAt: string;
    completedAt?: string | null;
  } | null;
  priority: string;
  scheduledAt: string;
  startedAt?: string | null;
  submittedAt?: string | null;
  completedAt?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: { id: string; displayName: string } | null;
  completionBlockedReason?: string | null;
  tbdReason?: string | null;
  followUpRequired?: boolean;
  followUpDueAt?: string | null;
  followUpTasks?: string | null;
  parentInspectionId?: string | null;
  inspectionRound?: number;
  createdAt: string;
  updatedAt: string;
  internalNotes?: string | null;
  /**
   * The report's closing block, written at sign-off. Distinct from
   * `internalNotes`, which is never published — these three are printed on the
   * document a tenant and an owner read.
   */
  nextInspectionAlert?: string | null;
  maintenanceComments?: string | null;
  generalComments?: string | null;
  propertySnapshot?: unknown;
  leaseSnapshot?: unknown;
  propertywareBuilding?: Pick<
    AdminProperty,
    'id' | 'name' | 'addressLine1' | 'city' | 'state'
  > | null;
  propertywareUnit?: Pick<AdminUnit, 'id' | 'name'> | null;
  propertywareLease?: Pick<AdminLease, 'id' | 'leaseName' | 'scheduledMoveOutDate'> | null;
  assignments: AdminAssignment[];
  audit?: Array<{ id: string; action: string; metadata?: unknown; createdAt: string }>;
}

export type ComparisonClassification =
  | 'UNCHANGED'
  | 'IMPROVED'
  | 'NEW_DAMAGE'
  | 'WORSENED'
  | 'RESOLVED'
  | 'MISSING_BASELINE'
  | 'MISSING_MOVE_OUT_EVIDENCE'
  | 'NOT_COMPARABLE'
  | 'REQUIRES_REVIEW';

export type ComparisonStatus = 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';

export type ComparisonMatchMethod =
  | 'LOCAL_AREA_ID'
  | 'APPROVED_ALIAS'
  | 'NORMALIZED_NAME'
  | 'AREA_CATEGORY'
  | 'CONFIGURED_MAPPING'
  | 'AI_SUGGESTED'
  | 'MANUAL'
  | 'UNMATCHED';

export interface AdminAreaComparison {
  id: string;
  areaName: string;
  floorName?: string | null;
  classification: ComparisonClassification;
  matchMethod: ComparisonMatchMethod;
  matchConfidence: number;
  requiresReview: boolean;
  summary?: string | null;
  originalClassification?: ComparisonClassification | null;
  overriddenAt?: string | null;
  overrideReason?: string | null;
}

/** Move-in vs move-out comparison for a move-out inspection (spec §12). */
export interface AdminInspectionComparison {
  id: string;
  moveOutInspectionId: string;
  moveInInspectionId: string;
  status: ComparisonStatus;
  overallCondition: ComparisonClassification;
  version: number;
  generator: string;
  requiresReviewCount: number;
  summary?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
  generatedAt: string;
  areas: AdminAreaComparison[];
}

export type ChargeStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'ADJUSTED'
  | 'WAIVED';
export type ChargeSource = 'AI_SUGGESTED' | 'TECHNICIAN' | 'SYSTEM' | 'ADMINISTRATOR';
export type PetReviewStatus = 'PENDING_REVIEW' | 'UNIQUE_PET' | 'DUPLICATE' | 'INSUFFICIENT_EVIDENCE';
export type PetAuthorizationStatus = 'UNKNOWN' | 'AUTHORIZED' | 'UNAUTHORIZED';

export interface AdminChargeRule {
  id: string;
  code: string;
  description?: string | null;
  amount: number;
  currency: string;
  calculationType: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export interface AdminCharge {
  id: string;
  inspectionId: string;
  chargeCode: string;
  description: string;
  propertyAreaId?: string | null;
  findingId?: string | null;
  petCandidateId?: string | null;
  quantity: number;
  unitAmount: number;
  proposedAmount: number;
  approvedAmount?: number | null;
  currency: string;
  status: ChargeStatus;
  source: ChargeSource;
  reason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
}

export interface AdminPetCandidate {
  id: string;
  species: string;
  label: string;
  description?: string | null;
  reviewStatus: PetReviewStatus;
  authorizationStatus: PetAuthorizationStatus;
  observationCount: number;
  reviewedAt?: string | null;
  reviewNote?: string | null;
}

export interface AdminPetObservation {
  id: string;
  petCandidateId?: string | null;
  temporaryLabel: string;
  species: string;
  description?: string | null;
  characteristics?: string | null;
  notes?: string | null;
  propertyAreaId?: string | null;
  photoIds: string[];
  mediaIds: string[];
  possibleDuplicateOfId?: string | null;
}

export interface AdminInspectionPets {
  candidates: AdminPetCandidate[];
  observations: AdminPetObservation[];
}

/** Charge comparison report (spec §14) — export-ready structured data. */
export interface AdminChargeReport {
  property: {
    name: string;
    address?: string | null;
    cityState?: string | null;
    unit?: string | null;
    lease?: string | null;
    scheduledMoveOut?: string | null;
  };
  inspection: { id: string; status: string; type: InspectionType; scheduledAt: string };
  comparison: {
    status: ComparisonStatus;
    overallCondition: ComparisonClassification;
    areas: Array<{ areaName: string; classification: ComparisonClassification; requiresReview: boolean }>;
  } | null;
  newOrWorsenedFindings: Array<{
    id: string;
    area: string;
    title: string;
    severity: string;
    reviewStatus: string;
  }>;
  existingConditionExclusions: Array<{ id: string; area: string; title: string }>;
  petReview: Array<{
    id: string;
    label: string;
    species: string;
    reviewStatus: PetReviewStatus;
    authorizationStatus: PetAuthorizationStatus;
    observationCount: number;
  }>;
  charges: { proposed: AdminCharge[]; approved: AdminCharge[]; rejected: AdminCharge[] };
  rule: AdminChargeRule | null;
  totals: { currency: string; proposedTotal: number; approvedTotal: number };
}

/** An inspection area shown in the workflow (used by the merge UI). */
export interface AdminInspectionArea {
  id: string;
  propertyAreaId: string;
  name: string;
  floorName?: string | null;
  environment: 'INDOOR' | 'OUTDOOR' | 'SEMI_OUTDOOR';
  completionStatus: string;
  mediaCount: number;
  photoCount: number;
}

/** Result of merging two inspection areas. */
export interface MergeInspectionAreasResult {
  movedMedia: number;
  movedPhotos: number;
  movedFindings: number;
  demotedPrimaries: number;
  areas: AdminInspectionArea[];
}

export interface AdminAuditEvent {
  id: string;
  action: string;
  createdAt: string;
}

export interface AdminReportShare {
  id: string;
  inspectionId: string;
  token: string;
  sharePath: string;
  recipientEmail?: string | null;
  expiresAt: string;
  revokedAt?: string | null;
  createdAt: string;
  /** Present on creation when the backend attempted SMTP delivery. */
  emailDeliveryStatus?: MailDeliveryStatus;
}

/** Letterhead block. Deployment-level branding, not per-organization. */
export interface PublicReportBrand {
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  phone?: string | null;
  email?: string | null;
}

/**
 * A homeowner-visible photo. Only area overviews and photos attached to an
 * APPROVED finding are ever included, so nothing here reveals pending or
 * rejected AI output. `contentPath` is capability-scoped by the share token.
 */
export interface PublicReportPhoto {
  id: string;
  roomId: string;
  /** Caption. The checklist item's name when the photo evidences one. */
  label?: string | null;
  /**
   * The checklist item this photograph evidences, if any.
   *
   * Carried separately from `label` so a renderer can group photographs under
   * their table row rather than only captioning them — which is how the
   * office's printed report is laid out.
   */
  checklistItem?: string | null;
  notes?: string | null;
  capturedAt: string;
  width?: number | null;
  height?: number | null;
  contentPath: string;
}

/** One checklist row as the printed report shows it. */
export interface PublicReportChecklistItem {
  id: string;
  label: string;
  /**
   * The words that identify this item — "wall", "ceiling".
   *
   * Carried so the report can find the finding that explains a failed axis.
   * Optional: a report generated against a backend that predates this still
   * renders, it just falls back to matching on the label alone.
   */
  keywords?: string[];
  isClean: boolean | null;
  isUndamaged: boolean | null;
  isWorking: boolean | null;
  comment?: string | null;
}

export interface PublicInspectionReport {
  brand: PublicReportBrand;
  property: {
    name: string;
    addressLine1: string;
    unitName?: string | null;
    city: string;
    state: string;
    postalCode: string;
  };
  inspection: {
    type: string;
    status: string;
    scheduledAt: string;
    completedAt?: string | null;
    /**
     * Who carried out the inspection, for the report's "Inspector" line.
     *
     * Every current assignee, joined — the office's reports name more than one
     * person on a job. Null when nobody is assigned; the report should not
     * claim an inspector it does not have.
     */
    inspector?: string | null;
    /**
     * The name of the form the inspector worked from — "Exit Inspection" — as
     * distinct from the enum. Deployment-overridable, because this is the
     * organisation's vocabulary.
     */
    templateLabel?: string | null;
  };
  rooms: Array<{
    id: string;
    name: string;
    floorName?: string | null;
    completionStatus: string;
    skipReason?: string | null;
    completedAt?: string | null;
    /**
     * The condition checklist as the technician scored it, in the order the
     * printed report prints it.
     *
     * Every axis is a **tri-state**: true, false, or null for "not assessed".
     * The report renders null as an empty cell, exactly as the office's
     * existing reports do — printing "No" for an unassessed row would publish
     * a defect nobody observed.
     */
    checklist: PublicReportChecklistItem[];
  }>;
  findings: Array<{
    id: string;
    /** InspectionArea id, so findings group under their room. Null if the room was removed. */
    roomId?: string | null;
    roomName: string;
    title: string;
    description: string;
    category: string;
    severity: string;
    comparisonResult: string;
    baselineCondition: string;
  }>;
  photos: PublicReportPhoto[];
  /**
   * The report's closing block, written by the reviewer at sign-off.
   *
   * Three fields rather than one note because they are read by different
   * people: the alert schedules the next visit, the maintenance comments become
   * work orders, and the general comments are what the tenant reads.
   */
  closing?: {
    nextInspectionAlert?: string | null;
    maintenanceComments?: string | null;
    generalComments?: string | null;
  };
  generatedAt: string;
}

export interface AdminInspectionPhoto {
  id: string;
  roomId: string;
  roomName: string;
  findingId?: string | null;
  captureType: 'AREA_OVERVIEW' | 'FINDING_DETAIL' | 'SUPPORTING_EVIDENCE';
  sequenceNumber: number;
  label?: string | null;
  notes?: string | null;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  capturedByName: string;
  capturedAt: string;
  contentPath: string;
}

export interface AdminInspectionMedia {
  id: string;
  roomId: string;
  roomName: string;
  floorName?: string | null;
  roomCompletionStatus: string;
  technicianName: string;
  mimeType: string;
  durationSeconds: number;
  recordingType: 'PRIMARY_AREA' | 'ADDITIONAL_ISSUE';
  label?: string | null;
  category?: string | null;
  uploadStatus: string;
  processingStatus: string;
  createdAt: string;
  contentPath: string;
  /** Signed poster-frame URL; null until processing has generated one. */
  thumbnailUrl?: string | null;
}

export interface AdminInspectionFinding {
  id: string;
  inspectionId: string;
  roomId: string;
  roomName: string;
  mediaId: string;
  findingType: string;
  category: string;
  title: string;
  description: string;
  baselineCondition: string;
  comparisonResult: string;
  videoTimestampStart: number;
  videoTimestampEnd: number;
  severity: string;
  possibleResponsibility: string;
  confidence: number;
  recommendedReview: string;
  reviewStatus: string;
  createdAt: string;
  lastReview?: {
    status: string;
    reason?: string | null;
    reviewerName: string;
    createdAt: string;
  } | null;
}

export interface AdminTechnician {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: string;
  workload?: { current: number; inProgress: number; completed: number };
  assignments?: AdminAssignment[];
  isOnline?: boolean;
  lastSeenAt?: string | null;
}

export interface CreatedTechnicianAccount extends AdminTechnician {
  mustChangePassword: true;
  temporaryPassword: string;
  emailDeliveryStatus: MailDeliveryStatus;
}

export type MailDeliveryStatus = 'SENT' | 'NOT_CONFIGURED' | 'FAILED';

export interface MailDeliveryResult {
  status: MailDeliveryStatus;
  message: string;
}

export interface ProviderReadiness {
  provider: string;
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'READY' | 'DEGRADED' | 'UNAVAILABLE' | 'ERROR';
  detail?: string;
}

export type AiProviderName = 'ANTHROPIC' | 'OPENAI';

export interface AiModelOption {
  id: string;
  name: string;
  tier: string;
  /** Published per-1M-token pricing, e.g. "$3 in / $15 out". */
  pricing?: string;
  /** One-line guidance on when this model fits the inspection workload. */
  description?: string;
  /** The tier we suggest for TexasRenters' transcript/finding workload. */
  recommended?: boolean;
}

export interface AiProviderConfiguration {
  provider: AiProviderName;
  displayName: string;
  modelId: string;
  models: AiModelOption[];
  hasApiKey: boolean;
  keySource: 'SETTINGS' | 'ENVIRONMENT' | 'NONE';
  credentialStatus: 'NOT_CONFIGURED' | 'UNVERIFIED' | 'VALID' | 'INVALID';
  lastValidatedAt: string | null;
  monthlyTokenBudget: number | null;
  balanceStatus: 'NOT_EXPOSED_BY_STANDARD_API_KEY';
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    remainingBudgetTokens: number | null;
    budgetPercentUsed: number | null;
    lastUsedAt: string | null;
  };
}

export interface AiSettings {
  activeProvider: AiProviderName;
  keyStorageAvailable: boolean;
  usageWindow: { startsAt: string; endsAt: string };
  providers: AiProviderConfiguration[];
}

export interface PropertywareSyncRun {
  id: string;
  syncType: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  recordsFetched: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsUnchanged: number;
  recordsDeactivated: number;
  recordsFailed: number;
  pagesFetched: number;
  warnings: number;
}

export interface PropertywareSyncError {
  id: string;
  entityType: string;
  errorCode: string;
  sanitizedMessage: string;
  retryable: boolean;
  createdAt: string;
  resolvedAt?: string | null;
}

/**
 * The Jobber connection as the console sees it. Never carries tokens — the
 * backend selects these columns explicitly so a credential column added later
 * cannot start being served by accident.
 */
export interface JobberConnection {
  status: 'CONNECTED' | 'DISCONNECTED' | 'REAUTHORIZATION_REQUIRED';
  jobberAccountId?: string | null;
  jobberAccountName?: string | null;
  apiVersion?: string | null;
  connectedAt?: string | null;
  disconnectedAt?: string | null;
  lastRefreshedAt?: string | null;
  lastRefreshError?: string | null;
  lastSyncStartedAt?: string | null;
  lastSyncCompletedAt?: string | null;
  lastSyncError?: string | null;
  lastSyncVisitCount?: number | null;
  /**
   * Whether a run is in flight right now, from either side.
   *
   * The scheduler's own guard only covers its ticks; a sync launched from the
   * console runs outside it. This is derived from the two timestamps, so it
   * catches both.
   */
  syncInProgress?: boolean;
  /**
   * The background schedule, which is independent of the connection.
   *
   * Being connected does not mean anything is being imported — the scheduler is
   * off unless three environment variables agree. `nextRunAt` comes from the
   * cron expression itself rather than last-run plus interval, which drifts as
   * soon as a run is slow or skipped.
   */
  schedule?: {
    enabled: boolean;
    cron?: string | null;
    nextRunAt?: string | null;
    running: boolean;
  } | null;
}

/**
 * A Jobber property waiting to be tied to one of ours.
 *
 * `visitImports` is the count of visits held behind this row — the number that
 * says how much work is blocked, which is what makes the queue worth ordering.
 */
export interface JobberPropertyLink {
  id: string;
  jobberPropertyId: string;
  jobberClientName?: string | null;
  jobberAddress?: string | null;
  status: 'LINKED' | 'UNMATCHED' | 'AMBIGUOUS' | 'IGNORED';
  unresolvedReason?: string | null;
  propertywareBuildingId?: string | null;
  propertywareBuilding?: { id: string; name: string } | null;
  updatedAt: string;
  _count?: { visitImports: number };
}

/** A Jobber visit that did not become an inspection, and why. */
export interface JobberVisitImport {
  id: string;
  jobberVisitId: string;
  jobberJobId?: string | null;
  status: 'PENDING' | 'IMPORTED' | 'UNMATCHED_PROPERTY' | 'REJECTED' | 'IGNORED';
  failureCode?: string | null;
  failureMessage?: string | null;
  attempts: number;
  lastAttemptAt?: string | null;
  inspectionId?: string | null;
  link?: {
    id: string;
    jobberAddress?: string | null;
    jobberClientName?: string | null;
    status: string;
  } | null;
}

/** Counts returned by a manual sync run, shown back to whoever pressed it. */
export interface JobberSyncResult {
  correlationId: string;
  visitsSeen: number;
  imported: number;
  rescheduled: number;
  unmatched: number;
  rejected: number;
  /** Already finished in Jobber, so deliberately not imported. */
  alreadyComplete: number;
  /** Typed, but a type this integration does not import (filter delivery). */
  notSynced: number;
  /** Technicians copied across from Jobber this run. */
  assigned: number;
  /** Inspections closed here because Jobber says the visit is finished. */
  completedFromJobber: number;
  skipped: number;
}
