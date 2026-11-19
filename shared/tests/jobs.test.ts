import { describe, expect, it } from 'vitest';

import {
  formatJobNumber,
  isJobInspectionType,
  jobCanCarryServices,
  jobKindsInOrder,
  jobLeadType,
  jobTitleFor,
  jobWorkLines,
  normalizeJobNumber,
} from '../src/index.js';

const none = { filterChange: false, pestControl: false, fleaTreatment: false };

describe('the inspection that leads a job', () => {
  it('is HVAC when there is one: its filters are scored on the filter change', () => {
    expect(jobLeadType(['OCCUPIED', 'HVAC'])).toBe('HVAC');
  });

  it('is then occupied, then a move-out, a move-in, back to market', () => {
    expect(jobLeadType(['MOVE_IN', 'OCCUPIED'])).toBe('OCCUPIED');
    expect(jobLeadType(['MOVE_IN', 'MOVE_OUT'])).toBe('MOVE_OUT');
    expect(jobLeadType(['BACK_TO_MARKET', 'MOVE_IN'])).toBe('MOVE_IN');
  });

  it('is the roof or a lockbox only when nothing else is in the job, and those carry no services', () => {
    expect(jobLeadType(['SUPRA_LOCKBOX_REMOVAL', 'ROOF'])).toBe('ROOF');
    expect(jobCanCarryServices(['ROOF', 'SUPRA_LOCKBOX_PLACEMENT'])).toBe(false);
    expect(jobCanCarryServices(['ROOF', 'MOVE_OUT'])).toBe(true);
  });

  it('is nobody in a job with no inspection', () => {
    expect(jobLeadType([])).toBeNull();
  });
});

describe('a job title the office did not type', () => {
  it('names the inspections in the office order, then the services', () => {
    expect(jobTitleFor(['HVAC', 'OCCUPIED'], { filterChange: true, pestControl: true, fleaTreatment: false })).toBe(
      'Occupied + HVAC, filters and pest control',
    );
  });

  it('is the inspection alone when nothing else is booked', () => {
    expect(jobTitleFor(['MOVE_OUT'], none)).toBe('Move-out');
    expect(jobTitleFor(['MOVE_OUT'])).toBe('Move-out');
  });

  it('lists three services with commas', () => {
    expect(jobTitleFor(['OCCUPIED'], { filterChange: true, pestControl: true, fleaTreatment: true })).toBe(
      'Occupied, filters, pest control and flea treatment',
    );
  });
});

describe("the work in a job, as the technician's email lists it", () => {
  it('puts the lead first, says "inspection" where it is one, then the services', () => {
    expect(
      jobWorkLines(['OCCUPIED', 'HVAC', 'SUPRA_LOCKBOX_REMOVAL'], { filterChange: true, pestControl: false, fleaTreatment: true }),
    ).toEqual(['HVAC inspection', 'Occupied inspection', 'Supra lockbox removal', 'AC filter change', 'Flea treatment']);
  });
});

describe('job numbers', () => {
  it('come from the series as J- and five digits', () => {
    expect(formatJobNumber(1)).toBe('J-00001');
    expect(formatJobNumber(10482)).toBe('J-10482');
    expect(formatJobNumber(123456)).toBe('J-123456');
  });

  it('are kept as typed, trimmed, spaces run together, in capitals', () => {
    expect(normalizeJobNumber('  wo  48213 ')).toBe('WO 48213');
    expect(normalizeJobNumber('j-00042')).toBe('J-00042');
    expect(normalizeJobNumber('2026/11.a_b')).toBe('2026/11.A_B');
  });

  it('are refused when they cannot be one', () => {
    for (const typed of ['', '   ', '#42', '-42', 'J 42!', 'x'.repeat(41), null, undefined])
      expect(normalizeJobNumber(typed)).toBeNull();
  });
});

describe('what a job can hold', () => {
  it('is the inspections, not a work order or a filter delivery: those come later', () => {
    expect(isJobInspectionType('SUPRA_LOCKBOX_PLACEMENT')).toBe(true);
    expect(isJobInspectionType('MAINTENANCE')).toBe(false);
    expect(isJobInspectionType('AC_FILTER_DELIVERY')).toBe(false);
  });
});

describe("a job's kinds as the Schedule lists them", () => {
  it('puts the lead first, then the office order, each once, and a joined work order last', () => {
    expect(jobKindsInOrder(['OCCUPIED', 'MAINTENANCE', 'HVAC', 'MOVE_IN', 'OCCUPIED'])).toEqual(['HVAC', 'MOVE_IN', 'OCCUPIED', 'MAINTENANCE']);
    expect(jobKindsInOrder([])).toEqual([]);
  });
});
