import { describe, expect, it } from 'vitest';

import {
  jobberBookingText,
  jobberBookingProblems,
  nextRescheduleMonday,
  rebookingFromVisit,
  rescheduleServices,
  suggestedRescheduleDay,
  type JobberBookingInput,
} from '../src/index.js';

describe('the day a reschedule is offered first', () => {
  it('is the next Monday kept for rescheduled visits', () => {
    // A Wednesday: the Monday after.
    expect(nextRescheduleMonday('2026-10-21')).toBe('2026-10-26');
    // A Monday itself is not "next".
    expect(nextRescheduleMonday('2026-10-26')).toBe('2026-11-02');
  });

  it('skips a Monday that is a holiday', () => {
    // 18 January 2027 is Martin Luther King Jr. Day.
    expect(nextRescheduleMonday('2027-01-12')).toBe('2027-01-25');
  });

  it('carries into the next quarter when this one has no Monday left', () => {
    expect(nextRescheduleMonday('2026-12-29')).toBe('2027-01-04');
  });

  it("is the technician's day while it is still ahead", () => {
    expect(suggestedRescheduleDay('2026-10-21', '2026-10-23')).toBe('2026-10-23');
    // Today or gone: the Monday instead.
    expect(suggestedRescheduleDay('2026-10-21', '2026-10-21')).toBe('2026-10-26');
    expect(suggestedRescheduleDay('2026-10-21', null)).toBe('2026-10-26');
  });
});

describe('the services a request names', () => {
  it('keeps the office order and drops what is not a service', () => {
    expect(rescheduleServices(['pestControl', 'roof', 'filterChange'])).toEqual(['filterChange', 'pestControl']);
  });
});

describe('booking a visit again from the one that asked', () => {
  const first: JobberBookingInput = {
    zone: 'Zone 4',
    benefitPackage: true,
    services: { filterChange: true, pestControl: true, fleaTreatment: false },
    filters: [{ size: '20x25x1', quantity: 2, location: 'upstairs hallway', media: false }],
    planTier: 'Basic',
    hvacOptedOut: false,
    contactTenantsBeforeArrival: true,
    tenants: [{ name: 'Sample Tenant', phones: ['555-010-0100'], unit: null }],
    accessNotes: ['Gate code 1234'],
    notes: [],
  };
  const text = jobberBookingText(first, { address: '1 Example St', scheduledOn: '2026-10-14', inspectionUrl: null });

  it('books only the services still to do, with everything else as the first visit had it', () => {
    const again = rebookingFromVisit({
      title: text.visitTitle,
      details: text.visitDetails,
      services: ['pestControl'],
      scheduledOn: '2026-10-14',
      reason: 'Tenant refused',
    });

    expect(again).toMatchObject({
      zone: 'Zone 4',
      benefitPackage: true,
      services: { filterChange: false, pestControl: true, fleaTreatment: false },
      // No filter change, so no filters to bring.
      filters: [],
      contactTenantsBeforeArrival: true,
      tenants: [{ name: 'Sample Tenant', phones: ['555-010-0100'] }],
    });
    expect(again.accessNotes.join(' ')).toContain('Gate code 1234');
    // Why, at the top of the notes, for the technician sent back.
    expect(again.notes[0]).toBe('Booked again from the visit on 2026-10-14: Tenant refused');
    expect(jobberBookingProblems(again)).toEqual([]);
  });

  it('brings the filters when the filter change is what was not done', () => {
    const again = rebookingFromVisit({
      title: text.visitTitle,
      details: text.visitDetails,
      services: ['filterChange'],
      scheduledOn: '2026-10-14',
      reason: 'No filters on the truck',
    });

    expect(again.services.filterChange).toBe(true);
    expect(again.filters).toEqual([expect.objectContaining({ size: '20x25x1', quantity: 2 })]);
  });

  it('books a one-off visit outside the package as one', () => {
    const again = rebookingFromVisit({
      title: '1 Example St - Occupied Inspection',
      details: null,
      services: [],
      scheduledOn: '2026-10-14',
      reason: 'Nobody home',
    });

    expect(again).toMatchObject({ zone: null, benefitPackage: false, filters: [], tenants: [] });
  });
});
