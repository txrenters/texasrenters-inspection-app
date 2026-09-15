import { JobberOutboundKind } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import {
  occupiedInspectionInDetails,
  resolveVisitType,
} from '../src/integrations/jobber/jobber.visit-type';
import { visitDetails, visitTitle } from '../src/planning/tbp-plan.service';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

const Q4 = { year: 2026, quarter: 4 } as const;

describe('the Jobber visit a quarterly plan will create', () => {
  /**
   * Reproduced from a real one:
   * `19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package`.
   *
   * Not improved on. Technicians and coordinators have read this shape for as
   * long as the programme has run, and a tidier format would be a change
   * nobody asked for on the one string every person in the workflow sees.
   *
   * The zone is given as the tenant report holds it, a bare number: the title
   * says "Zone 1" because the planner writes it so, not because the report did.
   */
  it('writes the title the office already reads', () => {
    expect(visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone: '1' }, Q4)).toBe(
      '19803 Bolton Bridge Ln - Zone 1 - Q4 2026 Tenant Benefit Package',
    );
  });

  it('leaves the zone segment out rather than writing an empty one', () => {
    expect(visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone: null }, Q4)).toBe(
      '19803 Bolton Bridge Ln - Q4 2026 Tenant Benefit Package',
    );
  });

  it('leaves out a zone the report holds as "Not Set" instead of writing it into the title', () => {
    expect(visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone: 'Not Set' }, Q4)).toBe(
      '19803 Bolton Bridge Ln - Q4 2026 Tenant Benefit Package',
    );
  });

  it('names the filters the tenancy actually has', () => {
    expect(visitDetails({ hvacFilterSizes: ['18x36x1', '20x25x1'] })).toBe(
      'Filter Change: 18x36x1 + 20x25x1 + Pest Control + Occupied Inspection',
    );
  });

  it('still asks for a filter change when no size is recorded', () => {
    expect(visitDetails({ hvacFilterSizes: [] })).toBe(
      'Filter Change + Pest Control + Occupied Inspection',
    );
  });
});

/**
 * The round trip, and the most important test in this file.
 *
 * A benefit-package title types as `AC_FILTER_DELIVERY`, which is in
 * `TYPES_NOT_SYNCED` and never becomes an inspection. Only the phrase
 * "Occupied Inspection" in the details line rescues it. So a visit this
 * planner creates is one our own sync would throw away unless the details
 * match what `occupiedInspectionInDetails` looks for — and the failure is
 * silent: the visit exists in Jobber, the technician drives to it, and no
 * inspection ever appears here to record what they found.
 */
describe('a visit we create is one we would import back', () => {
  it('types the generated title as a filter delivery, as the office writes it', () => {
    const resolution = resolveVisitType(visitTitle({ addressLine1: '1 Any St', zone: 'Zone 1' }, Q4));

    expect(resolution).toEqual({ outcome: 'RESOLVED', inspectionType: 'AC_FILTER_DELIVERY' });
  });

  it('rescues it to an occupied inspection through the details line', () => {
    expect(occupiedInspectionInDetails(visitDetails({ hvacFilterSizes: ['18x36x1'] }))).toBe(true);
  });

  it('rescues it even when the tenancy has no filter sizes on record', () => {
    expect(occupiedInspectionInDetails(visitDetails({ hvacFilterSizes: [] }))).toBe(true);
  });
});

/**
 * The job and visit a published stop is booked as.
 *
 * The job's title is built when the booking is sent, from the zone frozen on
 * the stop -- the tenant report's own "4" or "Not Set" -- while the visit's is
 * the title generated with the plan. Both have to say the zone the same way.
 */
describe('booking a published plan stop in Jobber', () => {
  const jobberEnvironment = {
    JOBBER_CLIENT_ID: 'client-id',
    JOBBER_CLIENT_SECRET: 'client-secret',
    JOBBER_API_VERSION: '2025-01-20',
    JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
    JOBBER_TBP_WRITE_ENABLED: 'true',
  };

  const withEnvironment = <T>(build: () => T): T => {
    const previous = { ...process.env };
    Object.assign(process.env, jobberEnvironment);
    try {
      return build();
    } finally {
      process.env = previous;
    }
  };

  const book = async (zone: string | null) => {
    const tx = {
      jobberOutboundTask: { update: jest.fn().mockResolvedValue({}) },
      inspection: { update: jest.fn().mockResolvedValue({}) },
      jobberVisitImport: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            inspectionId: 'inspection-1',
            kind: JobberOutboundKind.TBP_VISIT_CREATE,
            jobberVisitId: null,
            jobberJobId: null,
            createdById: null,
            servicesNoteSentAt: null,
            jobTitle: null,
            attempts: 0,
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({ jobberJobId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      tbpQuarterPlanStop: {
        findUnique: jest.fn().mockResolvedValue({
          visitTitle: visitTitle({ addressLine1: '19803 Bolton Bridge Ln', zone }, Q4),
          visitDetails: visitDetails({ hvacFilterSizes: ['18x36x1'] }),
          scheduledOn: new Date('2026-10-06T00:00:00.000Z'),
          zone,
          propertywareBuildingId: 'building-1',
          propertywareUnitId: null,
          plan: { quarterYear: 2026, quarterNumber: 4 },
        }),
      },
      jobberPropertyLink: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { jobberPropertyId: 'property-9', jobberAddress: '19803 Bolton Bridge Ln', propertywareUnitId: null },
          ]),
      },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const request = jest
      .fn()
      .mockResolvedValueOnce({ jobCreate: { userErrors: [], job: { id: 'job-9' } } })
      .mockResolvedValueOnce({ visitCreate: { userErrors: [], createdVisits: [{ id: 'visit-9' }] } });

    const worker = withEnvironment(
      () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
    );

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1, failed: 0 });
    return {
      jobTitle: request.mock.calls[0][2].input.title as string,
      visitTitle: request.mock.calls[1][2].input.visits[0].title as string,
    };
  };

  it('writes a zone the report holds as a bare number as "Zone N" on the job and the visit', async () => {
    await expect(book('4')).resolves.toEqual({
      jobTitle: 'Zone 4 - Q4 2026 Tenant Benefit Package',
      visitTitle: '19803 Bolton Bridge Ln - Zone 4 - Q4 2026 Tenant Benefit Package',
    });
  });

  it('leaves "Not Set" off the job and the visit', async () => {
    await expect(book('Not Set')).resolves.toEqual({
      jobTitle: 'Q4 2026 Tenant Benefit Package',
      visitTitle: '19803 Bolton Bridge Ln - Q4 2026 Tenant Benefit Package',
    });
  });
});
