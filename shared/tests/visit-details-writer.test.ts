import { describe, expect, it } from 'vitest';

import {
  bookingFromTenancy,
  formatOccupiedVisitDetails,
  jobberBookingProblems,
  jobberBookingText,
  occupiedJobTitle,
  occupiedVisitTitle,
  parseVisitDetails,
  type JobberBookingInput,
  type OccupiedVisitBooking,
} from '../src/index.js';

/**
 * What this system writes on a Jobber visit it books for an occupied inspection.
 *
 * It must read back through the same parser the office's own visits go through,
 * and keep the phrase the sync imports on. People, numbers and codes invented.
 */

const booking = (overrides: Partial<OccupiedVisitBooking> = {}): OccupiedVisitBooking => ({
  services: { filterChange: true, pestControl: true, fleaTreatment: false },
  filters: [
    { size: '20x25x4', quantity: 2, media: true, location: 'upstairs hallway' },
    { size: '12x12x1' },
  ],
  planTier: 'Basic',
  hvacOptedOut: true,
  contactTenantsBeforeArrival: true,
  tenants: [{ name: 'Jane Q Sample', phones: ['(832) 555-0101'] }],
  accessNotes: ['Gate Code: 4321 for tenant'],
  notes: ['Tenant has a very large dog and has no crates at this time'],
  inspectionUrl: 'https://inspection.texasrenters.com/inspections/inspection-1',
  ...overrides,
});

describe('the Details written on a booked visit', () => {
  it('is the office format, with the completion steps pointed at the app and a link back', () => {
    const text = formatOccupiedVisitDetails(booking());
    const lines = text.split('\n');

    expect(lines[0]).toBe(
      'Filter Change: (2 pcs) 20x25x4 MEDIA (upstairs hallway); 12x12x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)',
    );
    expect(text).toContain('Make sure to contact tenants that you are on your way.\nTenant: Jane Q Sample (832) 555-0101');
    expect(text).toContain('Texas Renters inspection: https://inspection.texasrenters.com/inspections/inspection-1');
    expect(text).toMatch(/Instruction for completion\n• Mark each service done or not done in the Texas Renters inspection app/);
    // The link sits before the steps: everything after their heading is a step.
    expect(text.indexOf('Texas Renters inspection:')).toBeLessThan(text.indexOf('Instruction for completion'));
  });

  it('reads back through the parser as exactly what was booked', () => {
    const read = parseVisitDetails(formatOccupiedVisitDetails(booking()));

    expect(read.services).toEqual({
      filterChange: true,
      pestControl: true,
      fleaTreatment: false,
      occupiedInspection: true,
      other: [],
    });
    expect(read.filters).toEqual([
      { size: '20x25x4', quantity: 2, location: 'upstairs hallway', media: true },
      { size: '12x12x1', quantity: 1, location: null, media: false },
    ]);
    expect(read.plan).toEqual({ tier: 'Basic', hvacOptedOut: true });
    expect(read.contactTenantsBeforeArrival).toBe(true);
    expect(read.tenants).toEqual([{ unit: null, name: 'Jane Q Sample', phones: ['(832) 555-0101'] }]);
    expect(read.accessNotes).toEqual(['Gate Code: 4321 for tenant']);
    expect(read.notes).toEqual([
      'Tenant has a very large dog and has no crates at this time',
      'Texas Renters inspection: https://inspection.texasrenters.com/inspections/inspection-1',
    ]);
    expect(read.completionInstructions).toHaveLength(5);
    expect(read.occupiedInspectionNotNeeded).toBe(false);
  });

  it('keeps the inspection on the services line whatever else is booked', () => {
    const text = formatOccupiedVisitDetails(
      booking({
        services: { filterChange: false, pestControl: false, fleaTreatment: true },
        filters: [],
        planTier: null,
        hvacOptedOut: false,
      }),
    );
    expect(text.split('\n')[0]).toBe('Flea Treatment + Occupied Inspection');
    expect(parseVisitDetails(text).services.occupiedInspection).toBe(true);
  });

  it('asks for sizes when filters are booked without any', () => {
    const read = parseVisitDetails(formatOccupiedVisitDetails(booking({ filters: [] })));
    expect(read.services.filterChange).toBe(true);
    expect(read.filterNotes).toEqual(['Update filter sizes']);
  });

  it('writes a tenant per unit on a visit covering several', () => {
    const read = parseVisitDetails(
      formatOccupiedVisitDetails(
        booking({
          tenants: [
            { unit: '101 N Main St', name: 'Alex Doe', phones: ['(281) 555-0103'] },
            { unit: '101 1/2 N Main St', name: 'Sam Roe', phones: ['(281) 555-0104', '(281) 555-0105'] },
          ],
        }),
      ),
    );
    expect(read.tenants).toEqual([
      { unit: '101 N Main St', name: 'Alex Doe', phones: ['(281) 555-0103'] },
      { unit: '101 1/2 N Main St', name: 'Sam Roe', phones: ['(281) 555-0104', '(281) 555-0105'] },
    ]);
  });
});

describe('the title of a booked visit', () => {
  it('is the benefit-package title the office reads, for the quarter of the visit', () => {
    expect(
      occupiedVisitTitle({ address: '100 Main St', zone: 'Zone 4', scheduledOn: '2026-10-06', benefitPackage: true }),
    ).toBe('100 Main St - Zone 4 - Q4 2026 Tenant Benefit Package');
    // The quarter is the visit day's, at both edges of one.
    expect(occupiedJobTitle({ zone: null, scheduledOn: '2026-03-31', benefitPackage: true })).toBe(
      'Q1 2026 Tenant Benefit Package',
    );
    expect(occupiedJobTitle({ zone: null, scheduledOn: '2026-07-01', benefitPackage: true })).toBe(
      'Q3 2026 Tenant Benefit Package',
    );
  });

  it('names a one-off occupied inspection as one', () => {
    expect(
      occupiedVisitTitle({ address: '100 Main St', zone: null, scheduledOn: '2026-10-06', benefitPackage: false }),
    ).toBe('100 Main St - Occupied Inspection');
  });

  it('titles the job as the office does, without the address', () => {
    expect(occupiedJobTitle({ zone: 'Zone 1', scheduledOn: '2026-08-11', benefitPackage: true })).toBe(
      'Zone 1 - Q3 2026 Tenant Benefit Package',
    );
    expect(occupiedJobTitle({ zone: null, scheduledOn: '2026-08-11', benefitPackage: false })).toBe(
      'Occupied Inspection',
    );
  });
});

describe('a booking sent from the console', () => {
  const input = (overrides: Partial<JobberBookingInput> = {}): JobberBookingInput => {
    const written = booking();
    return {
      services: written.services,
      filters: written.filters,
      planTier: written.planTier,
      hvacOptedOut: written.hvacOptedOut,
      contactTenantsBeforeArrival: written.contactTenantsBeforeArrival,
      tenants: written.tenants,
      accessNotes: written.accessNotes,
      notes: written.notes,
      zone: 'Zone 3',
      benefitPackage: true,
      ...overrides,
    };
  };

  it('writes the job, the visit title and the Details from one input', () => {
    const text = jobberBookingText(input({ filters: [{ size: '20 X 25 x 1', quantity: 2 }] }), {
      address: '100 Main St',
      scheduledOn: '2026-10-06',
      inspectionUrl: 'https://inspection.texasrenters.com/inspections/inspection-1',
    });
    expect(text.jobTitle).toBe('Zone 3 - Q4 2026 Tenant Benefit Package');
    expect(text.visitTitle).toBe('100 Main St - Zone 3 - Q4 2026 Tenant Benefit Package');
    // One spelling of a size, whatever was typed.
    expect(text.visitDetails.split('\n')[0]).toMatch(/^Filter Change: \(2 pcs\) 20x25x1 \+ Pest Control/);
    expect(parseVisitDetails(text.visitDetails).filters).toEqual([
      { size: '20x25x1', quantity: 2, location: null, media: false },
    ]);
  });

  it('refuses a size that is not one, and a quantity nobody carries', () => {
    expect(jobberBookingProblems(input({ filters: [{ size: 'UPDATE' }, { size: '16x25x1', quantity: 40 }] }))).toEqual([
      '"UPDATE" is not a filter size like 20x25x1.',
      'Filter 16x25x1 needs a quantity from 1 to 20.',
    ]);
    expect(jobberBookingProblems(input())).toEqual([]);
  });

  it('ignores the sizes when the filter change is not booked', () => {
    const unbooked = input({
      services: { filterChange: false, pestControl: true, fleaTreatment: false },
      filters: [{ size: 'UPDATE' }],
    });
    expect(jobberBookingProblems(unbooked)).toEqual([]);
    expect(
      jobberBookingText(unbooked, { address: '100 Main St', scheduledOn: '2026-10-06', inspectionUrl: null })
        .visitDetails,
    ).not.toContain('UPDATE');
  });
});

describe('a booking started from the tenant report', () => {
  it('reads the zone, the plan, the HVAC opt-out, the enrolment and the filters as the report holds them', () => {
    expect(
      bookingFromTenancy({
        zone: '2',
        managementPlan: 'Premium (w/o HVAC)',
        hvacPlan: 'Opted out HVAC Plan',
        hvacFilterLocation: 'Attic',
        hvacFilterSizes: ['20x25x4 MEDIA'],
        tbpEnrollment: 'Yes',
        tenantNames: ['Jane Q Sample', ' '],
      }),
    ).toEqual({
      zone: 'Zone 2',
      benefitPackage: true,
      planTier: 'Premium (w/o HVAC)',
      hvacOptedOut: true,
      filters: [{ size: '20x25x4', media: true, location: 'Attic' }],
      tenants: [{ name: 'Jane Q Sample', phones: [] }],
    });
  });

  it('leaves out what the report holds that is not a value', () => {
    const prefill = bookingFromTenancy({
      zone: 'Not Set',
      managementPlan: '',
      hvacPlan: 'On our AC Plan',
      hvacFilterLocation: 'UPDATE',
      hvacFilterSizes: ['20x25x1', '16x25x1', 'TBD'],
      tbpEnrollment: 'Not Verified',
      tenantNames: [],
    });
    expect(prefill).toMatchObject({ zone: null, benefitPackage: false, planTier: null, hvacOptedOut: false });
    // Two sizes and one location: which filter it names is not known.
    expect(prefill.filters).toEqual([
      { size: '20x25x1', media: false },
      { size: '16x25x1', media: false },
    ]);
  });

  it('writes a plan that already names itself without another "Plan"', () => {
    const text = formatOccupiedVisitDetails(booking({ planTier: 'Premium (w/o HVAC)', hvacOptedOut: true }));
    expect(text.split('\n')[0]).toMatch(/Occupied Inspection \(Premium \(w\/o HVAC\) - Opted Out HVAC Plan\)$/);
    expect(parseVisitDetails(text).plan).toEqual({ tier: 'Premium', hvacOptedOut: true });
    expect(parseVisitDetails(formatOccupiedVisitDetails(booking({ planTier: 'Plus' }))).plan?.tier).toBe('Plus');
  });
});

