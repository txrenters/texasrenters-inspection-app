import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  FindingReviewStatus,
  InspectionStatus,
  InspectionType,
  PropertyAreaStatus,
  UploadQueueStatus,
  type FindingContract,
  type InspectionAreaContract,
  type InspectionContract,
  type PropertyAreaContract,
  type UserRole,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import {
  InMemoryJobQueueProvider,
  LocalDevelopmentFloorPlanStorageProvider,
  MockAiAnalysisProvider,
  MockFloorPlanExtractionProvider,
  MockTranscriptionProvider,
  MockVideoPlatformProvider,
  type TranscriptSegment,
} from '../providers/mock.providers';
import type {
  CreateAreaDto,
  CreateInspectionDto,
  CreatePropertyDto,
  RegisterFloorPlanDto,
  RegisterMediaDto,
  UpdateAreaDto,
  UpdateFindingDto,
  UpdatePropertyDto,
} from './dto';

export interface PropertyRecord extends CreatePropertyDto {
  id: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}
export interface FloorPlanRecord extends RegisterFloorPlanDto {
  id: string;
  propertyId: string;
  storageKey: string;
  status: string;
  createdAt: string;
}
export interface ExtractionJobRecord {
  id: string;
  floorPlanId: string;
  status: string;
  provider: string;
  modelId: string;
  schemaVersion: string;
  areaIds: string[];
}
export interface UploadSessionRecord {
  id: string;
  inspectionAreaId: string;
  idempotencyKey: string;
  providerUploadId: string;
  uploadUrl: string;
  expiresAt: string;
}
export interface MediaRecord {
  id: string;
  organizationId: string;
  propertyId: string;
  inspectionId: string;
  inspectionAreaId: string;
  technicianId: string;
  providerMediaId: string;
  mimeType: string;
  durationSeconds: number;
  uploadStatus: string;
  processingStatus: string;
}
interface ReviewRecord {
  id: string;
  findingId: string;
  reviewerId: string;
  status: FindingReviewStatus;
  reason?: string;
  createdAt: string;
}
interface AuditRecord {
  id: string;
  organizationId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const PROPERTY_ID = '20000000-0000-4000-8000-000000000001';
const INSPECTION_ID = '30000000-0000-4000-8000-000000000001';
const TECHNICIAN_ID = '10000000-0000-4000-8000-000000000004';

@Injectable()
export class VerticalSliceService {
  private readonly properties: PropertyRecord[] = [];
  private readonly floorPlans: FloorPlanRecord[] = [];
  private readonly jobs: ExtractionJobRecord[] = [];
  private readonly areas: PropertyAreaContract[] = [];
  private readonly inspections: InspectionContract[] = [];
  private readonly uploadSessions: UploadSessionRecord[] = [];
  private readonly media: MediaRecord[] = [];
  private readonly transcripts = new Map<string, TranscriptSegment[]>();
  private readonly findings: FindingContract[] = [];
  private readonly reviews: ReviewRecord[] = [];
  private readonly audit: AuditRecord[] = [];
  private readonly webhooks = new Set<string>();

  constructor(
    @Inject(MockFloorPlanExtractionProvider)
    private readonly extraction: MockFloorPlanExtractionProvider,
    @Inject(MockVideoPlatformProvider)
    private readonly video: MockVideoPlatformProvider,
    @Inject(MockTranscriptionProvider)
    private readonly transcription: MockTranscriptionProvider,
    @Inject(MockAiAnalysisProvider)
    private readonly analysis: MockAiAnalysisProvider,
    @Inject(InMemoryJobQueueProvider)
    private readonly jobsQueue: InMemoryJobQueueProvider,
    @Inject(LocalDevelopmentFloorPlanStorageProvider)
    private readonly storage: LocalDevelopmentFloorPlanStorageProvider,
  ) {
    this.seedMockState();
  }

  private seedMockState() {
    const now = new Date().toISOString();
    this.properties.push({
      id: PROPERTY_ID,
      organizationId: ORGANIZATION_ID,
      name: 'Oak Ridge House',
      addressLine1: '1458 Oak Ridge Drive',
      city: 'Austin',
      state: 'TX',
      postalCode: '78704',
      createdAt: now,
      updatedAt: now,
    });
    const extracted = this.extraction.extract();
    this.areas.push(
      ...extracted.map((area, index) => ({
        id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        propertyId: PROPERTY_ID,
        ...area,
        status: PropertyAreaStatus.APPROVED,
      })),
    );
    this.inspections.push({
      id: INSPECTION_ID,
      propertyId: PROPERTY_ID,
      propertyName: 'Oak Ridge House',
      address: '1458 Oak Ridge Drive, Austin, TX 78704',
      technicianId: TECHNICIAN_ID,
      status: InspectionStatus.SCHEDULED,
      inspectionType: InspectionType.MOVE_IN,
      scheduledAt: '2026-07-18T15:00:00.000Z',
      areas: this.areas.map((area, index) => this.toInspectionArea(area, index)),
    });
  }

  private toInspectionArea(area: PropertyAreaContract, index: number): InspectionAreaContract {
    return {
      id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      inspectionId: INSPECTION_ID,
      propertyAreaId: area.id,
      name: area.name,
      floorName: area.floorName,
      inspectionOrder: area.inspectionOrder,
      isRequired: area.isRequired,
      completionStatus: 'PENDING',
      uploadStatus: UploadQueueStatus.PENDING,
      processingStatus: 'PENDING',
    };
  }

  listProperties(user: AuthenticatedUser) {
    return this.properties.filter((property) => property.organizationId === user.organizationId);
  }
  getProperty(user: AuthenticatedUser, id: string) {
    return this.assertProperty(user, id);
  }
  createProperty(user: AuthenticatedUser, input: CreatePropertyDto) {
    const now = new Date().toISOString();
    const property = {
      id: randomUUID(),
      organizationId: user.organizationId,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.properties.push(property);
    return property;
  }
  updateProperty(user: AuthenticatedUser, id: string, input: UpdatePropertyDto) {
    const property = this.assertProperty(user, id);
    Object.assign(property, input, { updatedAt: new Date().toISOString() });
    return property;
  }

  registerFloorPlan(user: AuthenticatedUser, propertyId: string, input: RegisterFloorPlanDto) {
    this.assertProperty(user, propertyId);
    const floorPlan = {
      id: randomUUID(),
      propertyId,
      ...input,
      storageKey: this.storage.register(input.fileName),
      status: 'UPLOADED',
      createdAt: new Date().toISOString(),
    };
    this.floorPlans.push(floorPlan);
    return floorPlan;
  }
  listFloorPlans(user: AuthenticatedUser, propertyId: string) {
    this.assertProperty(user, propertyId);
    return this.floorPlans.filter((plan) => plan.propertyId === propertyId);
  }
  extractFloorPlan(user: AuthenticatedUser, floorPlanId: string) {
    const plan = this.floorPlans.find((candidate) => candidate.id === floorPlanId);
    if (!plan) throw new ApplicationError(404, 'FLOOR_PLAN_NOT_FOUND', 'Floor plan was not found.');
    this.assertProperty(user, plan.propertyId);
    const extracted = this.jobsQueue.enqueue('floor-plan-extraction', () =>
      this.extraction.extract(),
    );
    const created = extracted.map((area) => ({
      id: randomUUID(),
      propertyId: plan.propertyId,
      ...area,
      status: PropertyAreaStatus.DRAFT,
    }));
    this.areas.push(...created);
    plan.status = 'REVIEW_REQUIRED';
    const job = {
      id: randomUUID(),
      floorPlanId,
      status: 'COMPLETED',
      provider: 'mock',
      modelId: 'mock-floor-plan-v1',
      schemaVersion: '1',
      areaIds: created.map((area) => area.id),
    };
    this.jobs.push(job);
    return job;
  }
  getExtractionJob(id: string) {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new ApplicationError(404, 'JOB_NOT_FOUND', 'Extraction job was not found.');
    return job;
  }

  listAreas(user: AuthenticatedUser, propertyId: string) {
    this.assertProperty(user, propertyId);
    return this.areas
      .filter((area) => area.propertyId === propertyId)
      .sort((a, b) => a.inspectionOrder - b.inspectionOrder);
  }
  createArea(user: AuthenticatedUser, propertyId: string, input: CreateAreaDto) {
    this.assertProperty(user, propertyId);
    this.assertUniqueArea(propertyId, input.floorName, input.name);
    const area = { id: randomUUID(), propertyId, ...input, status: PropertyAreaStatus.DRAFT };
    this.areas.push(area);
    return area;
  }
  updateArea(user: AuthenticatedUser, areaId: string, input: UpdateAreaDto) {
    const area = this.assertArea(areaId);
    this.assertProperty(user, area.propertyId);
    if (input.name || input.floorName)
      this.assertUniqueArea(
        area.propertyId,
        input.floorName ?? area.floorName,
        input.name ?? area.name,
        area.id,
      );
    Object.assign(area, input);
    return area;
  }
  deleteArea(user: AuthenticatedUser, areaId: string) {
    const area = this.assertArea(areaId);
    this.assertProperty(user, area.propertyId);
    if (
      this.inspections.some((inspection) =>
        inspection.areas.some((item) => item.propertyAreaId === areaId),
      )
    )
      throw new ApplicationError(
        409,
        'AREA_IN_USE',
        'An area used by an inspection cannot be deleted.',
      );
    const index = this.areas.indexOf(area);
    this.areas.splice(index, 1);
    return { deleted: true };
  }
  approveAreas(user: AuthenticatedUser, propertyId: string) {
    this.assertProperty(user, propertyId);
    const drafts = this.areas.filter(
      (area) => area.propertyId === propertyId && area.status === PropertyAreaStatus.DRAFT,
    );
    drafts.forEach((area) => {
      area.status = PropertyAreaStatus.APPROVED;
    });
    this.recordAudit(user, 'PROPERTY_AREAS_APPROVED', 'Property', propertyId);
    return drafts;
  }
  reorderAreas(user: AuthenticatedUser, propertyId: string, areaIds: string[]) {
    const available = this.listAreas(user, propertyId);
    if (
      new Set(areaIds).size !== areaIds.length ||
      areaIds.some((id) => !available.some((area) => area.id === id))
    )
      throw new ApplicationError(
        400,
        'INVALID_AREA_ORDER',
        'Area order contains duplicates or unknown areas.',
      );
    areaIds.forEach((id, index) => {
      this.assertArea(id).inspectionOrder = index + 1;
    });
    return this.listAreas(user, propertyId);
  }

  createInspection(user: AuthenticatedUser, input: CreateInspectionDto) {
    const property = this.assertProperty(user, input.propertyId);
    const approved = this.areas.filter(
      (area) => area.propertyId === property.id && area.status === PropertyAreaStatus.APPROVED,
    );
    if (!approved.length)
      throw new ApplicationError(
        409,
        'NO_APPROVED_AREAS',
        'Approve property areas before creating an inspection.',
      );
    const id = randomUUID();
    const inspection: InspectionContract = {
      id,
      propertyId: property.id,
      propertyName: property.name,
      address: `${property.addressLine1}, ${property.city}, ${property.state} ${property.postalCode}`,
      technicianId: input.technicianId,
      status: InspectionStatus.SCHEDULED,
      inspectionType: InspectionType.MOVE_IN,
      scheduledAt: new Date(input.scheduledAt).toISOString(),
      areas: approved.map((area) => ({
        ...this.toInspectionArea(area, 0),
        id: randomUUID(),
        inspectionId: id,
      })),
    };
    this.inspections.push(inspection);
    return inspection;
  }
  assignedInspections(user: AuthenticatedUser) {
    return this.inspections.filter((inspection) => inspection.technicianId === user.id);
  }
  getInspection(user: AuthenticatedUser, id: string) {
    const inspection = this.assertInspection(id);
    this.assertInspectionAccess(user, inspection);
    return inspection;
  }
  startInspection(user: AuthenticatedUser, id: string) {
    const inspection = this.getInspection(user, id);
    inspection.status = InspectionStatus.IN_PROGRESS;
    return inspection;
  }
  completeInspection(user: AuthenticatedUser, id: string) {
    const inspection = this.getInspection(user, id);
    const incomplete = inspection.areas.filter(
      (area) =>
        area.isRequired &&
        area.completionStatus !== 'SKIPPED' &&
        !this.media.some(
          (item) => item.inspectionAreaId === area.id && item.uploadStatus === 'UPLOADED',
        ),
    );
    if (incomplete.length)
      throw new ApplicationError(
        409,
        'INSPECTION_INCOMPLETE',
        'Required inspection areas are incomplete.',
        incomplete.map((area) => ({
          inspectionAreaId: area.id,
          areaName: area.name,
          reason: 'VIDEO_REQUIRED',
        })),
      );
    inspection.status = InspectionStatus.REVIEW_REQUIRED;
    return inspection;
  }

  getInspectionArea(user: AuthenticatedUser, areaId: string) {
    const { inspection, area } = this.findInspectionArea(areaId);
    this.assertInspectionAccess(user, inspection);
    return {
      ...area,
      baselineCondition:
        area.name === 'Bedroom 1'
          ? 'Good condition. Known defect: small paint chip beside the light switch.'
          : 'No baseline condition entered.',
    };
  }
  skipArea(user: AuthenticatedUser, areaId: string, reason: string) {
    const { area } = this.findInspectionAreaForUser(user, areaId);
    area.completionStatus = 'SKIPPED';
    (area as InspectionAreaContract & { skipReason?: string }).skipReason = reason;
    return area;
  }
  unskipArea(user: AuthenticatedUser, areaId: string) {
    const { area } = this.findInspectionAreaForUser(user, areaId);
    area.completionStatus = 'PENDING';
    delete (area as InspectionAreaContract & { skipReason?: string }).skipReason;
    return area;
  }
  completeArea(user: AuthenticatedUser, areaId: string) {
    const { area } = this.findInspectionAreaForUser(user, areaId);
    if (
      !this.media.some(
        (item) => item.inspectionAreaId === area.id && item.uploadStatus === 'UPLOADED',
      )
    )
      throw new ApplicationError(409, 'VIDEO_REQUIRED', 'A valid uploaded room video is required.');
    area.completionStatus = 'COMPLETED';
    return area;
  }

  createUploadSession(user: AuthenticatedUser, areaId: string, idempotencyKey: string) {
    const { area } = this.findInspectionAreaForUser(user, areaId);
    const propertyArea = this.assertArea(area.propertyAreaId);
    if (propertyArea.status !== PropertyAreaStatus.APPROVED)
      throw new ApplicationError(
        409,
        'AREA_NOT_APPROVED',
        'Only approved property areas can receive video.',
      );
    const existing = this.uploadSessions.find(
      (session) => session.idempotencyKey === idempotencyKey,
    );
    if (existing) {
      if (existing.inspectionAreaId !== areaId)
        throw new ApplicationError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency key belongs to another room.',
        );
      return existing;
    }
    const provider = this.video.createUploadSession(idempotencyKey);
    const session = { id: randomUUID(), inspectionAreaId: areaId, idempotencyKey, ...provider };
    this.uploadSessions.push(session);
    area.uploadStatus = UploadQueueStatus.UPLOADING;
    return session;
  }
  registerMedia(user: AuthenticatedUser, areaId: string, input: RegisterMediaDto) {
    const { inspection, area } = this.findInspectionAreaForUser(user, areaId);
    const session = this.uploadSessions.find(
      (candidate) =>
        candidate.inspectionAreaId === areaId &&
        candidate.providerUploadId === input.providerUploadId,
    );
    if (!session)
      throw new ApplicationError(
        409,
        'UPLOAD_SESSION_REQUIRED',
        'A valid upload session is required for this room.',
      );
    const duplicate = this.media.find((item) => item.providerMediaId === input.providerMediaId);
    if (duplicate) return duplicate;
    const record: MediaRecord = {
      id: randomUUID(),
      organizationId: user.organizationId,
      propertyId: inspection.propertyId,
      inspectionId: inspection.id,
      inspectionAreaId: area.id,
      technicianId: user.id,
      providerMediaId: input.providerMediaId,
      mimeType: input.mimeType,
      durationSeconds: input.durationSeconds,
      uploadStatus: 'UPLOADED',
      processingStatus: 'PROCESSING',
    };
    this.media.push(record);
    area.uploadStatus = UploadQueueStatus.COMPLETED;
    area.completionStatus = 'UPLOADED';
    area.processingStatus = 'PROCESSING';
    this.jobsQueue.enqueue('mock-media-processing', () => this.processMedia(record, area));
    return record;
  }
  listMedia(user: AuthenticatedUser, areaId: string) {
    this.findInspectionAreaForUser(user, areaId);
    return this.media.filter((item) => item.inspectionAreaId === areaId);
  }
  getMedia(user: AuthenticatedUser, mediaId: string) {
    const item = this.assertMedia(mediaId);
    const inspection = this.assertInspection(item.inspectionId);
    this.assertInspectionAccess(user, inspection, true);
    return { ...item, playbackUrl: `mock://playback/${item.providerMediaId}` };
  }
  retryMedia(user: AuthenticatedUser, mediaId: string) {
    const item = this.assertMedia(mediaId);
    const { area } = this.findInspectionAreaForUser(user, item.inspectionAreaId);
    this.processMedia(item, area);
    return item;
  }

  listFindings(user: AuthenticatedUser, inspectionId: string) {
    const inspection = this.assertInspection(inspectionId);
    this.assertInspectionAccess(user, inspection, true);
    return this.findings.filter((finding) => finding.inspectionId === inspectionId);
  }
  getFinding(user: AuthenticatedUser, findingId: string) {
    const finding = this.assertFinding(findingId);
    const inspection = this.assertInspection(finding.inspectionId);
    this.assertInspectionAccess(user, inspection, true);
    return finding;
  }
  editFinding(user: AuthenticatedUser, findingId: string, input: UpdateFindingDto) {
    const finding = this.getFinding(user, findingId);
    Object.assign(finding, input, { reviewStatus: FindingReviewStatus.EDITED });
    this.addReview(user, finding, FindingReviewStatus.EDITED);
    return finding;
  }
  approveFinding(user: AuthenticatedUser, findingId: string) {
    const finding = this.getFinding(user, findingId);
    finding.reviewStatus = FindingReviewStatus.APPROVED;
    this.addReview(user, finding, FindingReviewStatus.APPROVED);
    return finding;
  }
  rejectFinding(user: AuthenticatedUser, findingId: string, reason: string) {
    const finding = this.getFinding(user, findingId);
    finding.reviewStatus = FindingReviewStatus.REJECTED;
    this.addReview(user, finding, FindingReviewStatus.REJECTED, reason);
    return finding;
  }
  requestReinspection(user: AuthenticatedUser, findingId: string, reason: string) {
    const finding = this.getFinding(user, findingId);
    finding.reviewStatus = FindingReviewStatus.REINSPECTION_REQUESTED;
    this.addReview(user, finding, FindingReviewStatus.REINSPECTION_REQUESTED, reason);
    return finding;
  }

  processWebhook(provider: string, providerEventId: string) {
    const key = `${provider}:${providerEventId}`;
    const duplicate = this.webhooks.has(key);
    this.webhooks.add(key);
    return {
      provider,
      providerEventId,
      duplicate,
      status: duplicate ? 'IGNORED_DUPLICATE' : 'COMPLETED',
    };
  }
  diagnostics() {
    return {
      mode: 'mock',
      properties: this.properties.length,
      inspections: this.inspections.length,
      media: this.media.length,
      findings: this.findings.length,
      audits: this.audit.length,
      reviews: this.reviews.length,
    };
  }

  private processMedia(media: MediaRecord, area: InspectionAreaContract) {
    const transcript = this.transcription.transcribe();
    this.transcripts.set(media.id, transcript.segments);
    // Reprocessing replaces this recording's findings; retries must not append
    // a duplicate set on every attempt.
    const retained = this.findings.filter((finding) => finding.inspectionMediaId !== media.id);
    this.findings.length = 0;
    this.findings.push(...retained);
    const generated = this.analysis.analyze(area.propertyAreaId, area.name);
    generated.forEach((value) => {
      if (value.propertyAreaId !== area.propertyAreaId || value.areaName !== area.name)
        throw new ApplicationError(
          422,
          'AI_AREA_MISMATCH',
          'AI finding does not match the selected room.',
        );
      this.findings.push({
        id: randomUUID(),
        inspectionId: media.inspectionId,
        inspectionMediaId: media.id,
        ...value,
        reviewStatus: FindingReviewStatus.PENDING_REVIEW,
      });
    });
    media.processingStatus = 'READY';
    area.processingStatus = 'READY';
    area.reviewStatus = FindingReviewStatus.PENDING_REVIEW;
  }
  private addReview(
    user: AuthenticatedUser,
    finding: FindingContract,
    status: FindingReviewStatus,
    reason?: string,
  ) {
    this.reviews.push({
      id: randomUUID(),
      findingId: finding.id,
      reviewerId: user.id,
      status,
      reason,
      createdAt: new Date().toISOString(),
    });
    this.recordAudit(user, `FINDING_${status}`, 'InspectionFinding', finding.id);
  }
  private recordAudit(
    user: AuthenticatedUser,
    action: string,
    entityType: string,
    entityId: string,
  ) {
    this.audit.push({
      id: randomUUID(),
      organizationId: user.organizationId,
      actorUserId: user.id,
      action,
      entityType,
      entityId,
      createdAt: new Date().toISOString(),
    });
  }
  private assertProperty(user: AuthenticatedUser, id: string) {
    const property = this.properties.find(
      (item) => item.id === id && item.organizationId === user.organizationId,
    );
    if (!property) throw new ApplicationError(404, 'PROPERTY_NOT_FOUND', 'Property was not found.');
    return property;
  }
  private assertArea(id: string) {
    const area = this.areas.find((item) => item.id === id);
    if (!area) throw new ApplicationError(404, 'AREA_NOT_FOUND', 'Property area was not found.');
    return area;
  }
  private assertInspection(id: string) {
    const inspection = this.inspections.find((item) => item.id === id);
    if (!inspection)
      throw new ApplicationError(404, 'INSPECTION_NOT_FOUND', 'Inspection was not found.');
    return inspection;
  }
  private assertMedia(id: string) {
    const media = this.media.find((item) => item.id === id);
    if (!media)
      throw new ApplicationError(404, 'MEDIA_NOT_FOUND', 'Inspection media was not found.');
    return media;
  }
  private assertFinding(id: string) {
    const finding = this.findings.find((item) => item.id === id);
    if (!finding) throw new ApplicationError(404, 'FINDING_NOT_FOUND', 'Finding was not found.');
    return finding;
  }
  private assertInspectionAccess(
    user: AuthenticatedUser,
    inspection: InspectionContract,
    allowReviewer = false,
  ) {
    const privileged = user.roles.some((role: UserRole) =>
      ['SYSTEM_ADMIN', 'PROPERTY_ADMIN', 'INSPECTION_SUPERVISOR'].includes(role),
    );
    const reviewer =
      allowReviewer &&
      user.roles.some((role: UserRole) => ['CONDITION_REVIEWER', 'CHARGE_APPROVER'].includes(role));
    if (inspection.technicianId !== user.id && !privileged && !reviewer)
      throw new ApplicationError(
        403,
        'INSPECTION_ACCESS_DENIED',
        'You are not assigned to this inspection.',
      );
  }
  private findInspectionArea(id: string) {
    for (const inspection of this.inspections) {
      const area = inspection.areas.find((item) => item.id === id);
      if (area) return { inspection, area };
    }
    throw new ApplicationError(404, 'INSPECTION_AREA_NOT_FOUND', 'Inspection area was not found.');
  }
  private findInspectionAreaForUser(user: AuthenticatedUser, id: string) {
    const found = this.findInspectionArea(id);
    this.assertInspectionAccess(user, found.inspection);
    return found;
  }
  private assertUniqueArea(propertyId: string, floorName: string, name: string, ignoreId?: string) {
    if (
      this.areas.some(
        (area) =>
          area.id !== ignoreId &&
          area.propertyId === propertyId &&
          area.floorName.toLowerCase() === floorName.toLowerCase() &&
          area.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new ApplicationError(
        409,
        'DUPLICATE_AREA',
        'A room with this name already exists on the selected floor.',
      );
  }
}
