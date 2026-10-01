import { InspectionAreaCompletionStatus, JobberOutboundStatus } from '@prisma/client';
import type { VisitServicesReport } from '@texasrenters/shared';

import type { PrismaService } from '../src/common/prisma.service';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { JOB_NOTE_CREATE_MUTATION, VISIT_COMPLETE_MUTATION } from '../src/integrations/jobber/jobber.queries';
import { jobberServicesNote } from '../src/integrations/jobber/jobber.services-note';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

/**
 * The technician's services report, as the note the office reads in Jobber.
 *
 * Every benefit-package visit asks for "the corresponding numbers: 1.Filter
 * Change 2.Pest Control 3.HVAC / Occupied Inspection", typed by hand. People and
 * reasons here are invented.
 */

const DETAILS = 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection (Basic Plan)';
const RECORDED = new Date('2026-09-15T19:14:05Z');

const report = (overrides: Partial<VisitServicesReport> = {}): VisitServicesReport => ({
  services: {
    filterChange: { done: true, reason: null, reschedule: false },
    pestControl: { done: true, reason: null, reschedule: false },
  },
  filtersInstalled: ['20x25x1'],
  notes: null,
  ...overrides,
});

describe('the services note', () => {
  it('leads with the numbers the office asks for, then what each means', () => {
    expect(
      jobberServicesNote({
        report: report(),
        details: DETAILS,
        inspectionDone: true,
        technicianName: 'Pat Field',
        recordedAt: RECORDED,
      }),
    ).toBe(
      [
        'Services completed: 1, 2, 3',
        '1. Filter Change: done (installed 20x25x1)',
        '2. Pest Control: done',
        '3. HVAC / Occupied Inspection: done',
        'Recorded by Pat Field in the Texas Renters inspection app, Sep 15, 2026, 2:14:05 PM CDT.',
      ].join('\n'),
    );
  });

  it('says why a service was not done, and that it needs booking again', () => {
    const note = jobberServicesNote({
      report: report({
        services: {
          filterChange: { done: true, reason: null, reschedule: false },
          pestControl: { done: false, reason: 'Tenant asked not to spray today, has a newborn.', reschedule: true },
        },
        notes: 'Hallway filter was 16x25x1, not the size listed.',
      }),
      details: DETAILS,
      inspectionDone: true,
      technicianName: 'Pat Field',
      recordedAt: RECORDED,
    });
    expect(note).toContain('Services completed: 1, 3');
    expect(note).toContain(
      '2. Pest Control: NOT done. Tenant asked not to spray today, has a newborn. Needs to be rescheduled.',
    );
    expect(note).toContain('Notes: Hallway filter was 16x25x1, not the size listed.');
  });

  it('lists an unnumbered service by name, and an inspection nobody could walk as not done', () => {
    const note = jobberServicesNote({
      report: report({
        services: {
          filterChange: { done: false, reason: 'Nobody home, gate locked.', reschedule: true },
          pestControl: { done: true, reason: null, reschedule: false },
          fleaTreatment: { done: true, reason: null, reschedule: false },
        },
        filtersInstalled: [],
      }),
      details: 'Filter Change: 20x25x1 + Pest Control + Flea Treatment + Occupied Inspection',
      inspectionDone: false,
      technicianName: null,
      recordedAt: RECORDED,
    })!;
    const lines = note.split('\n');
    expect(lines[0]).toBe('Services completed: 2');
    expect(lines).toContain('3. HVAC / Occupied Inspection: NOT done');
    expect(lines).toContain('Flea Treatment: done');
    // The office's numbers first, anything they do not number after them.
    expect(lines.indexOf('Flea Treatment: done')).toBeGreaterThan(lines.indexOf('3. HVAC / Occupied Inspection: NOT done'));
    expect(lines.at(-1)).toBe('Recorded in the Texas Renters inspection app, Sep 15, 2026, 2:14:05 PM CDT.');
  });

  it('is nothing when there is nothing to say', () => {
    expect(
      jobberServicesNote({
        report: { services: {}, filtersInstalled: [], notes: null },
        details: null,
        inspectionDone: true,
        technicianName: null,
        recordedAt: RECORDED,
      }),
    ).toBeNull();
  });

  /**
   * Moses, 2026-10-01: an HVAC job scores its filters on the AC filter change,
   * and can take a listed filter off or correct its size.
   */
  it('says which listed filters were not there and which were another size', () => {
    const lines = jobberServicesNote({
      report: report({
        filtersInstalled: [],
        filters: [
          { size: '20x25x1', location: null, slot: 1, changed: true, reason: null, photoId: 'p-1', booked: true, actualSize: '20x20x1' },
          { size: '12x12x1', location: 'downstairs', slot: 1, changed: false, reason: null, photoId: null, booked: true, removed: true },
        ],
      }),
      details: 'Filter Change: 20x25x1; 12x12x1 downstairs + Pest Control + HVAC Inspection',
      inspectionType: 'HVAC',
      inspectionDone: true,
      technicianName: null,
      recordedAt: RECORDED,
    })!.split('\n');
    expect(lines).toContain('1. Filter Change: done (installed 20x20x1)');
    expect(lines).toContain('   12x12x1 · downstairs: not at the property.');
    expect(lines).toContain('   Listed as 20x25x1, actually 20x20x1.');
    // Neither is "not changed": one is not there, the other was changed.
    expect(lines.some((line) => line.includes('NOT changed'))).toBe(false);
  });

  it('leaves out the filter change an HVAC visit never booked, which the office has no number to tick for', () => {
    const note = jobberServicesNote({
      report: report({
        services: { filterChange: { done: true, reason: null, reschedule: false } },
        filtersInstalled: [],
        filters: [{ size: '16x25x1', location: null, slot: 1, changed: false, reason: null, photoId: null, booked: false, isClean: true }],
      }),
      details: 'HVAC Inspection',
      inspectionType: 'HVAC',
      inspectionDone: true,
      technicianName: null,
      recordedAt: RECORDED,
    });
    // Its scores are in the report; the note has nothing to say.
    expect(note).toBeNull();
  });

  it('still reports a filter change on any other job, booked or not', () => {
    const note = jobberServicesNote({
      report: report({ services: { filterChange: { done: true, reason: null, reschedule: false } } }),
      details: null,
      inspectionType: 'OCCUPIED',
      inspectionDone: false,
      technicianName: null,
      recordedAt: RECORDED,
    });
    expect(note).toContain('1. Filter Change: done (installed 20x25x1)');
  });
});

describe('sending the note with the completion', () => {
  const jobberEnvironment = {
    JOBBER_CLIENT_ID: 'client-id',
    JOBBER_CLIENT_SECRET: 'client-secret',
    JOBBER_API_VERSION: '2025-01-20',
    JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
  };

  const build = (task: Record<string, unknown>, env: Record<string, string> = {}) => {
    const request = jest.fn<Promise<unknown>, [string, string, unknown]>(async (_organizationId, query) =>
      query === JOB_NOTE_CREATE_MUTATION ? { jobCreateNote: { userErrors: [] } } : { visitComplete: { userErrors: [] } },
    );
    const prisma = {
      inspection: {
        findUnique: jest.fn(async (args: { select: Record<string, unknown> }) =>
          'servicesReport' in args.select
            ? {
                servicesReport: report(),
                servicesReportedAt: RECORDED,
                submittedAt: RECORDED,
                jobberVisitDetails: DETAILS,
                areas: [{ completionStatus: InspectionAreaCompletionStatus.COMPLETED }],
                assignments: [{ technician: { displayName: 'Pat Field' } }],
              }
            : { finalizedAt: null },
        ),
      },
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-1',
            inspectionId: 'inspection-1',
            kind: 'VISIT_COMPLETED',
            jobberVisitId: 'visit-1',
            jobberJobId: 'job-1',
            createdById: null,
            servicesNoteSentAt: null,
            attempts: 0,
            ...task,
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const previous = { ...process.env };
    Object.assign(process.env, jobberEnvironment, { JOBBER_PUSH_REPORT_LINK: 'false' }, env);
    try {
      const worker = new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient);
      return { worker, request, prisma };
    } finally {
      process.env = previous;
    }
  };

  it('posts the note to the job before marking the visit complete, and records that it went', async () => {
    const { worker, request, prisma } = build({});

    await expect(worker.run('organization-1')).resolves.toMatchObject({ sent: 1 });

    expect(request.mock.calls.map((call) => call[1])).toEqual([JOB_NOTE_CREATE_MUTATION, VISIT_COMPLETE_MUTATION]);
    expect(request.mock.calls[0]?.[2]).toEqual({
      jobId: 'job-1',
      input: { message: expect.stringMatching(/^Services completed: 1, 2, 3\n/) },
    });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { servicesNoteSentAt: expect.any(Date) },
    });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: JobberOutboundStatus.SENT }) }),
    );
  });

  it('does not post it twice when a retry follows a completion that failed', async () => {
    const { worker, request } = build({ servicesNoteSentAt: new Date('2026-09-15T19:20:00Z'), attempts: 1 });

    await worker.run('organization-1');

    expect(request.mock.calls.map((call) => call[1])).toEqual([VISIT_COMPLETE_MUTATION]);
  });

  it('can be switched off', async () => {
    const { worker, request } = build({}, { JOBBER_PUSH_SERVICES_NOTE: 'false' });

    await worker.run('organization-1');

    expect(request.mock.calls.map((call) => call[1])).toEqual([VISIT_COMPLETE_MUTATION]);
  });
});
