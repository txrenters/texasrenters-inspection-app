import { InspectionStatus, JobberOutboundKind } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import {
  benefitPackageInspectionInDetails,
  hvacInspectionInDetails,
  occupiedInspectionInDetails,
  resolveVisitType,
} from '../src/integrations/jobber/jobber.visit-type';
import { planVisitDetails, visitTitle } from '../src/planning/tbp-plan.service';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

const Q4 = { year: 2026, quarter: 4 } as const;

const TENANCY = {
  hvacFilterSizes: ['18x36x1', '20x25x1'],
  hvacFilterLocation: null,
  managementPlan: 'Premium',
  hvacPlan: 'Not Completed',
};

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

  /** "this is the details we are going to use" -- the office's Q4 sheet, 2026-09-16. */
  it('carries the office’s own services line, with the inspection this quarter’s rule chose', () => {
    const office = 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection';

    expect(planVisitDetails(TENANCY, 'HVAC', office)).toMatch(
      /^Filter Change: 20x25x1 \+ Pest Control \+ HVAC Inspection\n\nInstruction for completion\n/,
    );
    expect(planVisitDetails(TENANCY, 'OCCUPIED', office).split('\n')[0]).toBe(office);
  });

  it('names the filters the tenancy actually has where the sheet has no line for it', () => {
    expect(planVisitDetails(TENANCY, 'OCCUPIED').split('\n')[0]).toBe(
      'Filter Change: 18x36x1; 20x25x1 + Pest Control + Occupied Inspection',
    );
  });

  it('still asks for a filter change when no size is recorded', () => {
    expect(planVisitDetails({ ...TENANCY, hvacFilterSizes: [] }, 'OCCUPIED').split('\n')[0]).toBe(
      'Filter Change: Update filter sizes + Pest Control + Occupied Inspection',
    );
  });
});

/**
 * The round trip, and the most important test in this file.
 *
 * A benefit-package title types as `AC_FILTER_DELIVERY`, which is in
 * `TYPES_NOT_SYNCED` and never becomes an inspection. Only the inspection on
 * the services line rescues it. So a visit this planner creates is one our own
 * sync would throw away unless the details say what the sync looks for -- and
 * the failure is silent: the visit exists in Jobber, the technician drives to
 * it, and no inspection ever appears here to record what they found.
 */
describe('a visit we create is one we would import back', () => {
  it('types the generated title as a filter delivery, as the office writes it', () => {
    const resolution = resolveVisitType(visitTitle({ addressLine1: '1 Any St', zone: 'Zone 1' }, Q4));

    expect(resolution).toEqual({ outcome: 'RESOLVED', inspectionType: 'AC_FILTER_DELIVERY' });
  });

  it('rescues it to an occupied inspection through the details line', () => {
    expect(occupiedInspectionInDetails(planVisitDetails(TENANCY, 'OCCUPIED'))).toBe(true);
    expect(benefitPackageInspectionInDetails(planVisitDetails(TENANCY, 'OCCUPIED'))).toBe('OCCUPIED');
  });

  it('rescues it even when the tenancy has no filter sizes on record', () => {
    expect(benefitPackageInspectionInDetails(planVisitDetails({ ...TENANCY, hvacFilterSizes: [] }, 'OCCUPIED'))).toBe(
      'OCCUPIED',
    );
  });

  /**
   * An HVAC visit carries the office's completion steps too, and they read
   * "3.HVAC / Occupied Inspection". The services line decides.
   */
  it('reads an HVAC visit back as an HVAC inspection, completion steps and all', () => {
    const details = planVisitDetails(TENANCY, 'HVAC', 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection');

    expect(occupiedInspectionInDetails(details)).toBe(true);
    expect(benefitPackageInspectionInDetails(details)).toBe('HVAC');
  });

  it('does not read HVAC off anything but a services line', () => {
    expect(hvacInspectionInDetails('Tenant asked about an HVAC inspection next month')).toBe(false);
    expect(hvacInspectionInDetails('Instruction for completion\n1.Filter change 2.Pest control 3.HVAC / Occupied Inspection')).toBe(false);
    expect(hvacInspectionInDetails('Filter Change: 16x25x1 + Pest Control + HVAC Inspection')).toBe(true);
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

  const book = async (
    zone: string | null,
    inspection: Partial<{
      status: InspectionStatus;
      scheduledAt: Date;
      jobberVisitId: string | null;
      jobberVisitTitle: string | null;
      jobberVisitDetails: string | null;
      technicianEmail: string | null;
    }> = {},
  ) => {
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
          visitDetails: planVisitDetails(TENANCY, 'OCCUPIED'),
          scheduledOn: new Date('2026-10-06T00:00:00.000Z'),
          zone,
          propertywareBuildingId: 'building-1',
          propertywareUnitId: null,
          plan: { quarterYear: 2026, quarterNumber: 4 },
        }),
      },
      inspection: {
        findFirst: jest.fn().mockResolvedValue({
          status: inspection.status ?? InspectionStatus.SCHEDULED,
          scheduledAt: inspection.scheduledAt ?? new Date('2026-10-06T00:00:00.000Z'),
          jobberVisitId: inspection.jobberVisitId ?? null,
          jobberVisitTitle: inspection.jobberVisitTitle ?? null,
          jobberVisitDetails: inspection.jobberVisitDetails ?? null,
          assignments: inspection.technicianEmail ? [{ technician: { email: inspection.technicianEmail } }] : [],
        }),
      },
      jobberPropertyLink: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { jobberPropertyId: 'property-9', jobberAddress: '19803 Bolton Bridge Ln', propertywareUnitId: null },
          ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'jobber-user-7' }]),
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const request = jest
      .fn()
      .mockResolvedValueOnce({ jobCreate: { userErrors: [], job: { id: 'job-9' } } })
      .mockResolvedValueOnce({ visitCreate: { userErrors: [], createdVisits: [{ id: 'visit-9' }] } });

    const worker = withEnvironment(
      () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
    );

    const outcome = await worker.run('org-1');
    const visit = request.mock.calls[1]?.[2].input.visits[0];
    return {
      outcome,
      request,
      jobTitle: request.mock.calls[0]?.[2].input.title as string | undefined,
      visitTitle: visit?.title as string | undefined,
      visit,
    };
  };

  it('writes a zone the report holds as a bare number as "Zone N" on the job and the visit', async () => {
    const booked = await book('4');
    expect(booked.outcome).toMatchObject({ sent: 1, failed: 0 });
    expect({ jobTitle: booked.jobTitle, visitTitle: booked.visitTitle }).toEqual({
      jobTitle: 'Zone 4 - Q4 2026 Tenant Benefit Package',
      visitTitle: '19803 Bolton Bridge Ln - Zone 4 - Q4 2026 Tenant Benefit Package',
    });
  });

  it('leaves "Not Set" off the job and the visit', async () => {
    const booked = await book('Not Set');
    expect({ jobTitle: booked.jobTitle, visitTitle: booked.visitTitle }).toEqual({
      jobTitle: 'Q4 2026 Tenant Benefit Package',
      visitTitle: '19803 Bolton Bridge Ln - Q4 2026 Tenant Benefit Package',
    });
  });

  /** Between publish and booking the office may have moved the day or edited the Details on the inspection. */
  it('books the inspection’s day and Details as they are when it is sent', async () => {
    const { visit } = await book('4', {
      scheduledAt: new Date('2026-10-09T00:00:00.000Z'),
      jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + HVAC Inspection',
    });

    expect(visit.schedule.startAt).toEqual({ date: '2026-10-09', timezone: 'America/Chicago' });
    expect(visit.instructions).toBe('Filter Change: 20x25x1 + Pest Control + HVAC Inspection');
  });

  it('puts the planned technician on the visit when Jobber knows them', async () => {
    const { visit } = await book('4', { technicianEmail: 'moses@example.com' });

    expect(visit.schedule.teamMemberIdsToAssign).toEqual(['jobber-user-7']);
  });

  it('never books a visit for an inspection cancelled before it was sent', async () => {
    const { request, outcome } = await book('4', { status: InspectionStatus.CANCELLED });

    expect(request).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ sent: 0 });
  });
});
