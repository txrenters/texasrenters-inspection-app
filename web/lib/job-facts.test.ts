import type { AdminInspection } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { jobKeyFacts, jobsOnVisit } from './job-facts';
import { openWorkWords } from './job-page';

/**
 * The key information a job page opens on (the office, 2026-11-17): the same
 * three facts first on every job, then what matters for that kind of job at
 * that moment. Invented people and addresses.
 */

function job(over: Partial<AdminInspection> = {}): AdminInspection {
  return {
    id: 'insp-1',
    status: 'SCHEDULED',
    inspectionType: 'OCCUPIED',
    scheduledAt: '2026-11-16T00:00:00.000Z',
    jobberVisitDetails: '',
    ...over,
  } as AdminInspection;
}

const WALKED = {
  status: 'REVIEW_REQUIRED',
  startedAt: '2026-11-16T16:06:00.000Z',
  submittedAt: '2026-11-16T17:06:00.000Z',
} as const;

const facts = (inspection: AdminInspection, over: Partial<Parameters<typeof jobKeyFacts>[0]> = {}) =>
  jobKeyFacts({
    inspection,
    technicianName: 'Pat Lee',
    baseline: undefined,
    areas: { reviewed: 1, total: 3 },
    pendingFindings: 1,
    ...over,
  });
const keys = (list: ReturnType<typeof facts>) => list.map((fact) => fact.key);
const find = (list: ReturnType<typeof facts>, key: string) => list.find((fact) => fact.key === key)!;

describe('the first three facts', () => {
  it('are technician, date and time on site, on every type and in every state', () => {
    for (const inspectionType of ['MOVE_IN', 'MOVE_OUT', 'OCCUPIED', 'BACK_TO_MARKET', 'HVAC', 'ROOF', 'SUPRA_LOCKBOX_PLACEMENT', 'AC_FILTER_DELIVERY'])
      for (const state of [{}, WALKED, { status: 'CANCELLED' }])
        expect(keys(facts(job({ inspectionType, ...state } as Partial<AdminInspection>))).slice(0, 3)).toEqual([
          'technician',
          'date',
          'onSite',
        ]);
  });

  it('say the day with its weekday, and the hour the technician was there', () => {
    const list = facts(job(WALKED));
    expect(find(list, 'date').value).toMatch(/^Mon, /);
    expect(find(list, 'onSite').detail).toBe('1 hr on the job');
  });

  it('ask for a technician only while one is still needed', () => {
    expect(find(facts(job(), { technicianName: null }), 'technician')).toMatchObject({
      value: 'Not assigned',
      tone: 'warning',
    });
    expect(find(facts(job(WALKED), { technicianName: null }), 'technician').tone).toBeUndefined();
  });
});

describe('before the visit', () => {
  const details = 'Filter Change: 20x25x1 + Occupied Inspection\n\nTenant: Dana Park - 713-555-0100\nGate code 4411\nLockbox on the back door';

  it('says who to call and how to get in, from the visit’s Details, when they give them', () => {
    const list = facts(job({ jobberVisitDetails: details }));
    // Whatever the Details hold is shown; nothing is invented when they hold none.
    expect(keys(facts(job()))).toEqual(['technician', 'date', 'onSite', 'areas']);
    expect(find(list, 'areas').value).toBe('3 areas');
    expect(keys(list)).not.toContain('review');
    expect(keys(list)).not.toContain('work');
  });
});

describe('after the visit', () => {
  const report = {
    services: {
      filterChange: { done: true, reason: null, reschedule: false },
      pestControl: { done: true, reason: null, reschedule: false },
      fleaTreatment: { done: false, reason: 'Tenant refused entry.', reschedule: true },
    },
    filters: [],
    filtersInstalled: [],
  } as unknown as AdminInspection['servicesReport'];

  it('counts the jobs on the visit, the inspection among them', () => {
    const inspection = job({ ...WALKED, servicesReport: report, openWork: { services: ['fleaTreatment'], inspections: [] } });
    expect(jobsOnVisit(inspection, report).map((entry) => entry.done)).toEqual([true, true, false, true]);
    expect(find(facts(inspection), 'work')).toMatchObject({
      value: '3 of 4 jobs',
      meter: ['done', 'done', 'open', 'done'],
      tone: 'warning',
    });
  });

  it('counts the other inspection booked on the same visit as a job still owed', () => {
    const hvac = job({ ...WALKED, inspectionType: 'HVAC', openWork: { services: [], inspections: ['OCCUPIED'] } });
    expect(find(facts(hvac), 'work').value).toBe('1 of 2 jobs');
  });

  it('leaves the count out when the inspection is the only job', () => {
    expect(keys(facts(job(WALKED)))).not.toContain('work');
  });

  it('says what a move-out, an occupied visit and a back-to-market are compared with', () => {
    const baseline = { id: 'insp-in', scheduledAt: '2025-03-03T00:00:00.000Z' };
    expect(find(facts(job({ ...WALKED, inspectionType: 'MOVE_OUT' }), { baseline }), 'baseline')).toMatchObject({
      label: 'Compared with',
      href: '/inspections/insp-in',
    });
    expect(find(facts(job({ ...WALKED, inspectionType: 'MOVE_OUT' }), { baseline: null }), 'baseline')).toMatchObject({
      value: 'No move-in',
      tone: 'warning',
    });
    expect(find(facts(job({ ...WALKED, inspectionType: 'MOVE_IN' })), 'baseline').value).toBe('Move-in baseline');
    expect(keys(facts(job({ ...WALKED, inspectionType: 'HVAC' })))).not.toContain('baseline');
    expect(keys(facts(job({ ...WALKED, inspectionType: 'ROOF' })))).not.toContain('baseline');
  });

  it('says where the review stands, and how many findings wait', () => {
    expect(find(facts(job(WALKED)), 'review')).toMatchObject({
      value: '1 of 3 areas',
      detail: '1 finding to decide',
      tone: 'warning',
    });
    expect(find(facts(job(WALKED), { pendingFindings: 0 }), 'review').detail).toBe('No findings to decide');
    // An account that may not read findings is told nothing about them.
    expect(find(facts(job(WALKED), { pendingFindings: null }), 'review').detail).toBeUndefined();
  });

  it('adds the filters and the next inspection alert on an HVAC job', () => {
    const hvac = job({
      ...WALKED,
      inspectionType: 'HVAC',
      nextInspectionAlert: 'Bring a ladder for the attic hatch.',
      servicesReport: {
        services: {},
        filters: [
          { size: '20x25x1', changed: true },
          { size: '16x20x1', changed: false },
        ],
      } as unknown as AdminInspection['servicesReport'],
    });
    expect(find(facts(hvac), 'filters')).toMatchObject({ value: '1 of 2 changed', detail: '20x25x1 · 16x20x1', tone: 'warning' });
    expect(find(facts(hvac), 'alert').value).toBe('Bring a ladder for the attic hatch.');
  });

  it('stops at the three facts for a visit nobody could get into', () => {
    const blocked = job({ ...WALKED, completionBlockedReason: 'Could not get in: Tenant not home' });
    expect(keys(facts(blocked))).toEqual(['technician', 'date', 'onSite']);
  });
});

describe('what a partially complete visit still owes, in words', () => {
  it('names the services and the inspections', () => {
    expect(openWorkWords({ services: ['fleaTreatment'], inspections: [] })).toBe('Flea treatment still to do');
    expect(openWorkWords({ services: ['pestControl'], inspections: ['OCCUPIED'] })).toBe(
      'Pest control and occupied inspection still to do',
    );
    expect(openWorkWords({ services: ['filterChange', 'pestControl'], inspections: ['HVAC'] })).toMatch(
      /, pest control and HVAC inspection still to do$/,
    );
    expect(openWorkWords(null)).toBe('');
    expect(openWorkWords({ services: [], inspections: [] })).toBe('');
  });
});
