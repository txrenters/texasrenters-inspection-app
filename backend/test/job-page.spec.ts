import { InspectionStatus } from '@prisma/client';
import { jobStateOf } from '@texasrenters/shared';

import { canTakeOffJobWork, jobLeadInspection, jobServicesOf } from '../src/admin/jobs';

/**
 * What the job page reads off a job's inspections (2026-11-20, phase 5 of the
 * jobs plan). Ids and words invented.
 */

const row = (over: Partial<Parameters<typeof jobLeadInspection>[0][number]> & { id: string; inspectionType: string }) => ({
  status: InspectionStatus.SCHEDULED,
  startedAt: null,
  jobberVisitId: null,
  jobberVisitDetails: null,
  ...over,
});

describe("a job's lead", () => {
  it('is the inspection holding the Jobber visit, whatever its kind', () => {
    const rows = [row({ id: 'hvac', inspectionType: 'HVAC' }), row({ id: 'occ', inspectionType: 'OCCUPIED', jobberVisitId: 'v-1' })];
    expect(jobLeadInspection(rows)?.id).toBe('occ');
  });

  it('is the one carrying the services when nothing is booked in Jobber: work added later never takes it', () => {
    const rows = [
      row({ id: 'occ', inspectionType: 'OCCUPIED', jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection' }),
      // HVAC would lead a new job, but this one was added after.
      row({ id: 'hvac', inspectionType: 'HVAC' }),
    ];
    expect(jobLeadInspection(rows)?.id).toBe('occ');
  });

  it('is the leading kind when neither says, and a taken-off one never leads a job with work left', () => {
    const rows = [
      row({ id: 'hvac', inspectionType: 'HVAC', status: InspectionStatus.CANCELLED }),
      row({ id: 'out', inspectionType: 'MOVE_OUT' }),
      row({ id: 'occ', inspectionType: 'OCCUPIED' }),
    ];
    expect(jobLeadInspection(rows)?.id).toBe('occ');
  });
});

describe("the lead's services", () => {
  it('lists each with the answer the technician gave, an HVAC lead with its filter change always', () => {
    const services = jobServicesOf({
      ...row({ id: 'hvac', inspectionType: 'HVAC', jobberVisitDetails: 'Pest Control + Flea Treatment + HVAC Inspection' }),
      servicesReport: {
        services: { filterChange: { done: true, reason: null, reschedule: false }, pestControl: { done: false, reason: 'Tenant asked to come back', reschedule: true } },
        filtersInstalled: [],
        notes: null,
      },
    });
    expect(services).toEqual([
      { key: 'filterChange', label: 'AC filter change', outcome: 'DONE', reason: null },
      { key: 'pestControl', label: 'Pest control', outcome: 'NOT_DONE', reason: 'Tenant asked to come back' },
      { key: 'fleaTreatment', label: 'Flea treatment', outcome: 'TODO', reason: null },
    ]);
  });
});

describe('taking work off a job', () => {
  const lead = row({ id: 'occ', inspectionType: 'OCCUPIED' });

  it('is offered for work nobody has started that is not the lead', () => {
    expect(canTakeOffJobWork(row({ id: 'hvac', inspectionType: 'HVAC' }), lead, 2)).toBe(true);
  });

  it('is not offered once it has been started or handed in', () => {
    expect(canTakeOffJobWork(row({ id: 'hvac', inspectionType: 'HVAC', startedAt: new Date() }), lead, 2)).toBe(false);
    expect(canTakeOffJobWork(row({ id: 'hvac', inspectionType: 'HVAC', status: InspectionStatus.IN_PROGRESS }), lead, 2)).toBe(false);
  });

  it('is not offered for the lead while others remain, nor for the last work on the job', () => {
    expect(canTakeOffJobWork(lead, lead, 2)).toBe(false);
    expect(canTakeOffJobWork(row({ id: 'hvac', inspectionType: 'HVAC' }), lead, 1)).toBe(false);
  });
});

describe("a job's state", () => {
  it('is Partially complete while one is done and another is still owed', () => {
    expect(jobStateOf(['DONE', 'SCHEDULED'])).toBe('PARTIALLY_COMPLETE');
    expect(jobStateOf(['PARTIALLY_COMPLETE'])).toBe('PARTIALLY_COMPLETE');
  });

  it('is Complete only when every live one is, taken-off ones not counting', () => {
    expect(jobStateOf(['DONE', 'CANCELLED', 'DONE'])).toBe('DONE');
    expect(jobStateOf(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });

  it('is In progress while any is being walked, else Scheduled', () => {
    expect(jobStateOf(['DONE', 'IN_PROGRESS'])).toBe('IN_PROGRESS');
    expect(jobStateOf(['SCHEDULED', 'SCHEDULED'])).toBe('SCHEDULED');
    expect(jobStateOf(['COULD_NOT_GET_IN', 'COULD_NOT_GET_IN'])).toBe('COULD_NOT_GET_IN');
  });
});
