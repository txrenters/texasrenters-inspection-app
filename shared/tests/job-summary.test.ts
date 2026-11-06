import { describe, expect, it } from 'vitest';

import { inspectionWords, isTbpVisit, jobWork, jobWorkLine, visitZone } from '../src/contracts/job-summary.js';

/**
 * A job in one line (the office, 2026-11-06): what it is for, from what was
 * booked, and whether it is a benefit-package visit. Addresses invented.
 */

const DETAILS = 'Filter Change: 20x30x1 + Pest Control + Occupied Inspection\n\nCompletion Instruction\nChange every filter';

describe("a job's work", () => {
  it('reads the services booked, then the inspection, each once', () => {
    expect(jobWorkLine({ inspectionType: 'OCCUPIED', jobberVisitDetails: DETAILS })).toBe('AC filter change + Pest control + Occupied inspection');
  });

  it('is the inspection alone when nothing else was booked', () => {
    expect(jobWork({ inspectionType: 'MOVE_OUT', jobberVisitDetails: null })).toEqual(['Move-out inspection']);
    expect(jobWork({ inspectionType: 'MOVE_IN' })).toEqual(['Move-in inspection']);
  });

  it('names the other job the same visit booked, whichever way round', () => {
    expect(jobWork({ inspectionType: 'HVAC', jobberCompanions: [{ inspectionType: 'OCCUPIED' }] })).toEqual(['HVAC inspection', 'Occupied inspection']);
    expect(jobWork({ inspectionType: 'OCCUPIED', jobberCompanionOf: { inspectionType: 'HVAC' } })).toEqual(['Occupied inspection', 'HVAC inspection']);
  });

  it('does not say a filter delivery twice', () => {
    expect(jobWork({ inspectionType: 'AC_FILTER_DELIVERY', jobberVisitDetails: 'Filter Change' })).toEqual(['AC filter change']);
    expect(jobWork({ inspectionType: 'AC_FILTER_DELIVERY' })).toEqual(['AC filter delivery']);
  });

  it('keeps a type this list has not met readable', () => {
    expect(inspectionWords('POOL_CHECK')).toBe('Pool check');
  });
});

describe('a benefit-package visit', () => {
  it("is one on a quarter's plan, or booked as one, written either way", () => {
    expect(isTbpVisit({ onPlan: true, jobberVisitTitle: null })).toBe(true);
    expect(isTbpVisit({ onPlan: false, jobberVisitTitle: '100 Example Way - Zone 1 - Q4 Tenant Benefit Package' })).toBe(true);
    expect(isTbpVisit({ onPlan: false, jobberVisitTitle: 'Q4 2026 TBP - Occupied Inspection' })).toBe(true);
  });

  it('is not any other visit, whatever a word happens to contain', () => {
    expect(isTbpVisit({ onPlan: false, jobberVisitTitle: 'Move-in inspection' })).toBe(false);
    expect(isTbpVisit({ onPlan: false, jobberVisitTitle: 'Outbuilding repair' })).toBe(false);
    expect(isTbpVisit({ onPlan: false })).toBe(false);
  });
});

describe("a visit's zone", () => {
  it('is the one its title names', () => {
    expect(visitZone('100 Example Way - Zone 4 - Q4')).toBe('4');
    expect(visitZone('100 Example Way')).toBeNull();
    expect(visitZone(null)).toBeNull();
  });
});
