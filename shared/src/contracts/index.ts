import type {
  FindingReviewStatus,
  InspectionStatus,
  InspectionType,
  PropertyAreaStatus,
  UploadQueueStatus,
} from '../enums/index.js';
import type { AiFinding } from '../schemas/finding.js';

export interface PropertyAreaContract {
  id: string;
  propertyId: string;
  floorName: string;
  name: string;
  inspectionOrder: number;
  isRequired: boolean;
  status: PropertyAreaStatus;
}

export interface InspectionAreaContract {
  id: string;
  inspectionId: string;
  propertyAreaId: string;
  name: string;
  floorName: string;
  inspectionOrder: number;
  isRequired: boolean;
  completionStatus: string;
  uploadStatus: UploadQueueStatus;
  processingStatus: string;
  reviewStatus?: FindingReviewStatus;
}

export interface InspectionContract {
  id: string;
  propertyId: string;
  propertyName: string;
  address: string;
  technicianId: string;
  status: InspectionStatus;
  inspectionType: InspectionType;
  baselineInspectionId?: string | null;
  scheduledAt: string;
  areas: InspectionAreaContract[];
}

export interface FindingContract extends AiFinding {
  id: string;
  inspectionId: string;
  inspectionMediaId: string;
  reviewStatus: FindingReviewStatus;
}

export interface ApiErrorContract {
  statusCode: number;
  code: string;
  message: string;
  details: unknown[];
  requestId: string;
}

export * from './admin.js';
export * from './api-gateway.js';
export * from './area-evidence.js';
export * from './password-policy.js';
export * from './area-checklist-template.js';
export * from './hvac-checklist.js';
export * from './occupied-checklist.js';
export * from './standard-layout.js';
export * from './checklist-comment.js';
export * from './area-classification.js';
export * from './inspection-scope.js';
export * from './property-location.js';
export * from './route-plan.js';
export * from './technician-location.js';
