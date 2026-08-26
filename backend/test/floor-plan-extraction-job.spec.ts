import { UserRole } from '@texasrenters/shared';

import { FloorPlanAdminService } from '../src/admin/floor-plan-admin.service';
import type { AuthenticatedUser } from '../src/common/auth';

const admin: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Property Admin',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: [],
  mustChangePassword: false,
  // Added with `principalType`; these fixtures are people, not integrations.
  principalType: 'USER',
};

const PLAN = {
  id: 'plan-1',
  propertyId: 'building-1',
  unitId: null,
  storageKey: 'private/plan.png',
  fileName: 'plan.png',
  mimeType: 'image/png',
};

function service(prisma: Record<string, unknown>, extraction: Record<string, unknown> = {}) {
  return new FloorPlanAdminService(
    prisma as never,
    { get: jest.fn().mockResolvedValue(Buffer.from('plan')) } as never,
    {
      descriptor: jest
        .fn()
        .mockReturnValue({ provider: 'openai', modelId: 'm', schemaVersion: '1' }),
      extract: jest.fn(),
      ...extraction,
    } as never,
    // Returns nothing per area, so the service falls back to the shared
    // templates and these assertions stay deterministic and offline.
    {
      generate: async (list: unknown[]) => ({ items: list.map(() => []), fellBack: true }),
    } as never,
    { resolve: jest.fn().mockResolvedValue({ provider: 'OPENAI', modelId: 'm' }) } as never,
  );
}

describe('asynchronous floor plan extraction', () => {
  it('returns the job without waiting for the model call', async () => {
    let releaseModel: () => void = () => undefined;
    const modelCall = new Promise((resolve) => {
      releaseModel = () => resolve({ areas: [], usage: {} });
    });
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue(PLAN),
        update: jest.fn().mockResolvedValue(PLAN),
      },
      floorPlanExtractionJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(),
    };
    const subject = service(prisma, { extract: jest.fn().mockReturnValue(modelCall) });

    // The model call is still in flight; the request must not be waiting on it.
    // Before this change the 58s call sat inside the HTTP request and the
    // socket was destroyed at HTTP_REQUEST_TIMEOUT_MS.
    const started = await subject.extract(admin, 'plan-1');

    expect(started).toEqual({ jobId: 'job-1', status: 'RUNNING' });
    releaseModel();
  });

  it('refuses a second extraction while one is genuinely running', async () => {
    const prisma = {
      propertyFloorPlan: { findFirst: jest.fn().mockResolvedValue(PLAN) },
      floorPlanExtractionJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'job-1', updatedAt: new Date() }),
        create: jest.fn(),
      },
    };

    await expect(service(prisma).extract(admin, 'plan-1')).rejects.toMatchObject({
      status: 409,
      code: 'EXTRACTION_ALREADY_RUNNING',
    });
    expect(prisma.floorPlanExtractionJob.create).not.toHaveBeenCalled();
  });

  it('lets a new extraction start when the previous one was abandoned', async () => {
    const abandoned = new Date(Date.now() - 60 * 60 * 1000);
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue(PLAN),
        update: jest.fn().mockResolvedValue(PLAN),
      },
      floorPlanExtractionJob: {
        findFirst: jest.fn().mockResolvedValue({ id: 'stale', updatedAt: abandoned }),
        create: jest.fn().mockResolvedValue({ id: 'job-2' }),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(),
    };
    const subject = service(prisma, {
      extract: jest.fn().mockResolvedValue({ areas: [], usage: {} }),
    });

    // A process restart must not lock a plan out of extraction forever.
    await expect(subject.extract(admin, 'plan-1')).resolves.toMatchObject({ jobId: 'job-2' });
  });

  it('reports a job abandoned mid-flight as failed instead of polling forever', async () => {
    const abandoned = new Date(Date.now() - 60 * 60 * 1000);
    const prisma = {
      propertyFloorPlan: {
        findFirst: jest.fn().mockResolvedValue(PLAN),
        update: jest.fn().mockResolvedValue(PLAN),
      },
      floorPlanExtractionJob: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'job-1',
            status: 'RUNNING',
            errorCode: null,
            output: null,
            updatedAt: abandoned,
          }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    await expect(service(prisma).extractionJob(admin, 'plan-1', 'job-1')).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'FLOOR_PLAN_EXTRACTION_TIMED_OUT',
    });
    // The plan must not be left PROCESSING either.
    expect(prisma.propertyFloorPlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
  });

  it('returns the summary once the job completes', async () => {
    const summary = { detectedCount: 12, createdCount: 12, alreadyPresentCount: 0 };
    const prisma = {
      propertyFloorPlan: { findFirst: jest.fn().mockResolvedValue(PLAN) },
      floorPlanExtractionJob: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'job-1',
          status: 'COMPLETED',
          errorCode: null,
          output: { summary },
          updatedAt: new Date(),
        }),
      },
    };

    await expect(service(prisma).extractionJob(admin, 'plan-1', 'job-1')).resolves.toEqual({
      id: 'job-1',
      status: 'COMPLETED',
      errorCode: null,
      summary,
    });
  });

  it('refuses a job id belonging to another plan', async () => {
    const prisma = {
      propertyFloorPlan: { findFirst: jest.fn().mockResolvedValue(PLAN) },
      // Scoped query matches nothing for a foreign job.
      floorPlanExtractionJob: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    await expect(
      service(prisma).extractionJob(admin, 'plan-1', 'foreign-job'),
    ).rejects.toMatchObject({ status: 404, code: 'EXTRACTION_JOB_NOT_FOUND' });
  });
});
