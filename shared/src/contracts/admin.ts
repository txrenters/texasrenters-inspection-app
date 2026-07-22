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
  portfolio: { id: string; name: string; externalId: string };
  _count?: { units: number; inspections: number };
  units?: AdminUnit[];
  leases?: AdminLease[];
  inspections?: AdminInspection[];
}

export interface AdminFloorPlan {
  id: string;
  propertyId: string;
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

export interface AdminPropertyArea {
  id: string;
  propertyId: string;
  name: string;
  inspectionOrder: number;
  isRequired: boolean;
  status: 'DRAFT' | 'APPROVED' | 'REJECTED';
  source: string;
  floor?: { id: string; name: string; sortOrder: number } | null;
  _count?: { inspectionAreas: number };
}

export interface AdminUnit {
  id: string;
  externalId: string;
  name: string;
  isActive: boolean;
  bedrooms?: number | null;
  bathrooms?: number | null;
  lastSyncedAt: string;
}

export interface AdminLease {
  id: string;
  externalId: string;
  leaseName?: string | null;
  sourceStatus?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  scheduledMoveOutDate?: string | null;
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

export interface AdminInspection {
  id: string;
  status: string;
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
  createdAt: string;
  updatedAt: string;
  internalNotes?: string | null;
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
}

export interface PublicInspectionReport {
  property: {
    name: string;
    addressLine1: string;
    city: string;
    state: string;
    postalCode: string;
  };
  inspection: {
    type: string;
    status: string;
    scheduledAt: string;
    completedAt?: string | null;
  };
  rooms: Array<{
    id: string;
    name: string;
    floorName?: string | null;
    completionStatus: string;
    skipReason?: string | null;
    completedAt?: string | null;
  }>;
  findings: Array<{
    id: string;
    roomName: string;
    title: string;
    description: string;
    category: string;
    severity: string;
    comparisonResult: string;
    baselineCondition: string;
  }>;
  generatedAt: string;
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
  uploadStatus: string;
  processingStatus: string;
  createdAt: string;
  contentPath: string;
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
}

export interface CreatedTechnicianAccount extends AdminTechnician {
  mustChangePassword: true;
  temporaryPassword: string;
}

export interface ProviderReadiness {
  provider: string;
  status: 'CONFIGURED' | 'NOT_CONFIGURED' | 'READY' | 'DEGRADED' | 'UNAVAILABLE' | 'ERROR';
  detail?: string;
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
