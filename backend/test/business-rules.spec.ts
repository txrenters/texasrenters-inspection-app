import { Test } from '@nestjs/testing';
import { FindingReviewStatus, PropertyAreaStatus, UserRole } from '@texasrenters/shared';

import { ApplicationError } from '../src/common/errors';
import {
  InMemoryJobQueueProvider,
  LocalDevelopmentFloorPlanStorageProvider,
  MockAiAnalysisProvider,
  MockFloorPlanExtractionProvider,
  MockTranscriptionProvider,
  MockVideoPlatformProvider,
} from '../src/providers/mock.providers';
import { VerticalSliceService } from '../src/vertical-slice/vertical-slice.service';

const technician = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Taylor',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
};
const otherTechnician = {
  ...technician,
  id: '90000000-0000-4000-8000-000000000001',
  authUserId: 'auth-other-technician',
};
const reviewer = {
  ...technician,
  id: '10000000-0000-4000-8000-000000000005',
  authUserId: 'auth-reviewer',
  roles: [UserRole.CONDITION_REVIEWER],
};

describe('inspection business rules', () => {
  let service: VerticalSliceService;
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VerticalSliceService,
        MockFloorPlanExtractionProvider,
        MockVideoPlatformProvider,
        MockTranscriptionProvider,
        MockAiAnalysisProvider,
        InMemoryJobQueueProvider,
        LocalDevelopmentFloorPlanStorageProvider,
      ],
    }).compile();
    service = module.get(VerticalSliceService);
  });

  it('prevents access to another technician inspection', () => {
    expect(() =>
      service.getInspection(otherTechnician, '30000000-0000-4000-8000-000000000001'),
    ).toThrow(ApplicationError);
  });

  it('allows videos only for approved rooms and binds media to one room', () => {
    const inspection = service.getInspection(technician, '30000000-0000-4000-8000-000000000001');
    const bedroom = inspection.areas.find((area) => area.name === 'Bedroom 1')!;
    const propertyArea = service
      .listAreas(technician, inspection.propertyId)
      .find((area) => area.id === bedroom.propertyAreaId)!;
    propertyArea.status = PropertyAreaStatus.DRAFT;
    expect(() => service.createUploadSession(technician, bedroom.id, 'draft-room')).toThrow(
      ApplicationError,
    );
    propertyArea.status = PropertyAreaStatus.APPROVED;
    const session = service.createUploadSession(technician, bedroom.id, 'bedroom-video');
    const media = service.registerMedia(technician, bedroom.id, {
      providerUploadId: session.providerUploadId,
      providerMediaId: 'mock-bedroom-video',
      mimeType: 'video/mp4',
      durationSeconds: 37,
    });
    expect(media.inspectionAreaId).toBe(bedroom.id);
    expect(service.listFindings(reviewer, inspection.id)[0]?.reviewStatus).toBe(
      FindingReviewStatus.PENDING_REVIEW,
    );
  });

  it('blocks completion until required rooms have video or skip reasons', () => {
    expect(() =>
      service.completeInspection(technician, '30000000-0000-4000-8000-000000000001'),
    ).toThrow(ApplicationError);
    const inspection = service.getInspection(technician, '30000000-0000-4000-8000-000000000001');
    inspection.areas
      .filter((area) => area.isRequired)
      .forEach((area) => service.skipArea(technician, area.id, 'Authorized inaccessible room'));
    expect(service.completeInspection(technician, inspection.id).status).toBe('REVIEW_REQUIRED');
  });

  it('processes duplicate webhooks idempotently', () => {
    expect(service.processWebhook('cloudflare-stream', 'evt-1').duplicate).toBe(false);
    expect(service.processWebhook('cloudflare-stream', 'evt-1').duplicate).toBe(true);
  });

  it('finding review creates an audit event and never creates a charge', () => {
    const inspection = service.getInspection(technician, '30000000-0000-4000-8000-000000000001');
    const bedroom = inspection.areas.find((area) => area.name === 'Bedroom 1')!;
    const session = service.createUploadSession(technician, bedroom.id, 'review-video');
    service.registerMedia(technician, bedroom.id, {
      providerUploadId: session.providerUploadId,
      providerMediaId: 'review-media',
      mimeType: 'video/mp4',
      durationSeconds: 37,
    });
    const finding = service.listFindings(reviewer, inspection.id)[0]!;
    expect(service.approveFinding(reviewer, finding.id).reviewStatus).toBe(
      FindingReviewStatus.APPROVED,
    );
    expect(service.diagnostics().audits).toBe(1);
    expect('tenantCharge' in finding).toBe(false);
  });
});
