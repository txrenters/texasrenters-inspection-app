import { InspectionStatus } from '@prisma/client';
import { visitStateOf } from '@texasrenters/shared';

import { visitOpenWork, visitStateWhere } from '../src/common/inspection-done';

/**
 * "As long as one of the jobs is not finished, don't mark the status complete,
 * instead say partially complete" (the office, 2026-11-17). A job is a booked
 * service or the other inspection booked on the same Jobber visit.
 */

type Record = Parameters<typeof visitOpenWork>[0];

function visit(over: Partial<Record> = {}): Record {
  return {
    status: InspectionStatus.TECHNICIAN_SUBMITTED,
    rescheduleRequests: [],
    jobberCompanionOf: null,
    jobberCompanions: [],
    ...over,
  };
}

const request = (status: string, services: string[], rebook: InspectionStatus | null = null) => ({
  status,
  services,
  rebookInspection: rebook ? { status: rebook } : null,
});

const stateOf = (record: Record) => visitStateOf({ status: record.status, openWork: visitOpenWork(record) });

describe('what a submitted visit still owes', () => {
  it('owes nothing when every job was done', () => {
    expect(visitOpenWork(visit())).toBeNull();
    expect(stateOf(visit())).toBe('DONE');
  });

  it('owes the services the technician asked to have booked again', () => {
    const record = visit({ rescheduleRequests: [request('OPEN', ['fleaTreatment', 'pestControl'])] });
    // In the office's order, whatever order they were asked in.
    expect(visitOpenWork(record)).toEqual({ services: ['pestControl', 'fleaTreatment'], inspections: [] });
    expect(stateOf(record)).toBe('PARTIALLY_COMPLETE');
  });

  it('still owes one while the answer is on its way to Jobber', () => {
    expect(stateOf(visit({ rescheduleRequests: [request('SENDING', ['pestControl'])] }))).toBe('PARTIALLY_COMPLETE');
  });

  it('still owes one booked again until that visit is done', () => {
    const booked = visit({ rescheduleRequests: [request('DONE', ['pestControl'], InspectionStatus.SCHEDULED)] });
    expect(stateOf(booked)).toBe('PARTIALLY_COMPLETE');
    const returned = visit({ rescheduleRequests: [request('DONE', ['pestControl'], InspectionStatus.TECHNICIAN_SUBMITTED)] });
    expect(stateOf(returned)).toBe('DONE');
  });

  it('owes nothing once the return visit is cancelled, or was booked in Jobber with no visit here', () => {
    expect(stateOf(visit({ rescheduleRequests: [request('DONE', ['pestControl'], InspectionStatus.CANCELLED)] }))).toBe('DONE');
    expect(stateOf(visit({ rescheduleRequests: [request('DONE', ['pestControl'])] }))).toBe('DONE');
  });

  it('owes the other inspection booked on the same visit, either way round', () => {
    const hvac = visit({ jobberCompanions: [{ inspectionType: 'OCCUPIED', status: InspectionStatus.SCHEDULED }] });
    expect(visitOpenWork(hvac)).toEqual({ services: [], inspections: ['OCCUPIED'] });
    const occupied = visit({ jobberCompanionOf: { inspectionType: 'HVAC', status: InspectionStatus.IN_PROGRESS } });
    expect(stateOf(occupied)).toBe('PARTIALLY_COMPLETE');
    const both = visit({ jobberCompanions: [{ inspectionType: 'OCCUPIED', status: InspectionStatus.REVIEW_REQUIRED }] });
    expect(stateOf(both)).toBe('DONE');
    const called = visit({ jobberCompanions: [{ inspectionType: 'OCCUPIED', status: InspectionStatus.CANCELLED }] });
    expect(stateOf(called)).toBe('DONE');
  });

  it('says nothing about a visit still to happen: all of it is owed, and it says so already', () => {
    const scheduled = visit({ status: InspectionStatus.SCHEDULED, rescheduleRequests: [request('OPEN', ['pestControl'])] });
    expect(visitOpenWork(scheduled)).toBeNull();
    expect(stateOf(scheduled)).toBe('SCHEDULED');
  });

  it('leaves a visit nobody could get into as that', () => {
    expect(
      visitStateOf({
        status: 'TECHNICIAN_SUBMITTED',
        completionBlockedReason: 'Could not get in: Tenant not home',
        openWork: { services: ['pestControl'], inspections: [] },
      }),
    ).toBe('COULD_NOT_GET_IN');
  });
});

describe('the list filter', () => {
  const owed = JSON.stringify(visitStateWhere('PARTIALLY_COMPLETE'));

  it('finds partially complete visits by the same things the badge reads', () => {
    expect(owed).toContain('SERVICES_NOT_DONE');
    expect(owed).toContain('rebookInspection');
    expect(owed).toContain('jobberCompanionOf');
    expect(owed).toContain('jobberCompanions');
    expect(owed).toContain('Could not get in');
  });

  it('keeps them out of Complete, so no visit is in both', () => {
    const done = visitStateWhere('DONE') as { NOT?: unknown };
    expect(JSON.stringify(done.NOT)).toContain('SERVICES_NOT_DONE');
  });
});
