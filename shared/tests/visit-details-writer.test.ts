import { describe, expect, it } from 'vitest';

import {
  COMPLETION_BLOCKS,
  bookingFromTenancy,
  formatOccupiedVisitDetails,
  isBookableInspectionType,
  jobberBookingProblems,
  jobberBookingText,
  occupiedJobTitle,
  occupiedVisitTitle,
  parseVisitDetails,
  tenancyZoneLabel,
  visitServicesDetails,
  visitServicesProblems,
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

describe('the services of a visit created here but not booked in Jobber from here', () => {
  const services = (overrides: Partial<OccupiedVisitBooking['services']> = {}) => ({
    filterChange: false,
    pestControl: false,
    fleaTreatment: false,
    ...overrides,
  });

  it('is the services line alone, ending with the inspection', () => {
    const details = visitServicesDetails('HVAC', {
      services: services({ filterChange: true, pestControl: true }),
      filters: [{ size: '16 x 25 x 1', media: true }, { size: '20x20x1', location: 'Upstairs' }],
    });
    expect(details).toBe('Filter Change: 16x25x1 MEDIA; 20x20x1 (Upstairs) + Pest Control + HVAC Inspection');
    const read = parseVisitDetails(details);
    expect(read.services).toMatchObject({ filterChange: true, pestControl: true, occupiedInspection: false });
    expect(read.filters.map((filter) => filter.size)).toEqual(['16x25x1', '20x20x1']);
  });

  it('names an occupied inspection as the sync reads one, and asks for sizes it was not given', () => {
    expect(visitServicesDetails('OCCUPIED', { services: services({ filterChange: true, fleaTreatment: true }), filters: [] })).toBe(
      'Filter Change: Update filter sizes + Flea Treatment + Occupied Inspection',
    );
  });

  it('is nothing when the visit books no service', () => {
    expect(visitServicesDetails('MOVE_IN', { services: services(), filters: [{ size: '20x25x1' }] })).toBeNull();
  });

  it('checks the sizes only when the filter change is booked', () => {
    const filters = [{ size: 'UPDATE' }];
    expect(visitServicesProblems({ services: services({ filterChange: true }), filters })).toEqual([
      '"UPDATE" is not a filter size like 20x25x1.',
    ]);
    expect(visitServicesProblems({ services: services({ pestControl: true }), filters })).toEqual([]);
  });
});

describe('a zone read off the tenant report', () => {
  it('is written "Zone N", however the report typed the number', () => {
    expect(tenancyZoneLabel('4')).toBe('Zone 4');
    expect(tenancyZoneLabel(' 2 ')).toBe('Zone 2');
    expect(tenancyZoneLabel('04')).toBe('Zone 4');
    expect(tenancyZoneLabel('zone5')).toBe('Zone 5');
    // Already labelled: unchanged, so labelling twice is harmless.
    expect(tenancyZoneLabel('Zone 3')).toBe('Zone 3');
  });

  it('is nothing when the report holds no zone', () => {
    expect(tenancyZoneLabel('Not Set')).toBeNull();
    expect(tenancyZoneLabel('')).toBeNull();
    expect(tenancyZoneLabel(null)).toBeNull();
    expect(tenancyZoneLabel(undefined)).toBeNull();
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


describe('a booking for each other kind of inspection', () => {
  const input = (overrides: Partial<JobberBookingInput> = {}): JobberBookingInput => ({
    zone: 'Zone 2',
    benefitPackage: false,
    services: { filterChange: true, pestControl: true, fleaTreatment: false },
    filters: [{ size: 'UPDATE' }],
    planTier: 'Basic',
    hvacOptedOut: true,
    contactTenantsBeforeArrival: true,
    tenants: [{ name: 'Alex Doe', phones: ['(281) 555-0103'] }],
    accessNotes: ['LB Code: 1234'],
    notes: ['Tenant moving in 9/30'],
    ...overrides,
  });
  const visit = (inspectionType: 'MOVE_IN' | 'MOVE_OUT' | 'BACK_TO_MARKET' | 'HVAC') => ({
    inspectionType,
    address: '200 Oak Ave',
    scheduledOn: '2026-10-01',
    inspectionUrl: 'https://inspection.texasrenters.com/inspections/inspection-2',
  });

  it.each([
    ['MOVE_IN', '200 Oak Ave - Zone 2 - Move in Inspection', 'Zone 2 - Move in Inspection'],
    ['MOVE_OUT', '200 Oak Ave - Zone 2 - Move out inspection', 'Zone 2 - Move out inspection'],
    ['BACK_TO_MARKET', '200 Oak Ave - Zone 2 - BTM Inspection', 'Zone 2 - BTM Inspection'],
    ['HVAC', '200 Oak Ave - Zone 2 - HVAC Inspection', 'Zone 2 - HVAC Inspection'],
  ] as const)('titles a %s visit the way the office does', (type, visitTitle, jobTitle) => {
    const text = jobberBookingText(input(), visit(type));
    expect(text.visitTitle).toBe(visitTitle);
    expect(text.jobTitle).toBe(jobTitle);
  });

  const noServices = { filterChange: false, pestControl: false, fleaTreatment: false };

  it.each(['MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET', 'HVAC'] as const)(
    'writes %s Details with no services line when none is booked, and nothing the sync reads as occupied',
    (type) => {
      const details = jobberBookingText(input({ services: noServices }), visit(type)).visitDetails;
      expect(details).not.toMatch(/occupied\s+insp/i);
      expect(details).not.toMatch(/Filter Change|Pest Control|Basic Plan|UPDATE|done or not done/);
      expect(details).not.toMatch(/Inspect Cloud/i);
      const read = parseVisitDetails(details);
      expect(read.services.occupiedInspection).toBe(false);
      expect(read.tenants).toEqual([{ unit: null, name: 'Alex Doe', phones: ['(281) 555-0103'] }]);
      expect(read.accessNotes).toEqual(['LB Code: 1234']);
      // The office's block, whole, as the parser finds it.
      expect(read.completionInstructions.length).toBeGreaterThan(0);
      expect(details.endsWith(COMPLETION_BLOCKS[type].slice(1).join('\n'))).toBe(true);
    },
  );

  it.each([
    ['MOVE_IN', 'Move in Inspection'],
    ['MOVE_OUT', 'Move out inspection'],
    ['BACK_TO_MARKET', 'BTM Inspection'],
    ['HVAC', 'HVAC Inspection'],
  ] as const)('opens %s Details with the services it books, the way the office writes them', (type, kind) => {
    const details = jobberBookingText(
      input({ filters: [{ size: '20 X 25 x 1', quantity: 2, location: 'Hallway' }] }),
      visit(type),
    ).visitDetails;
    expect(details.split('\n')[0]).toBe(`Filter Change: (2 pcs) 20x25x1 (Hallway) + Pest Control + ${kind}`);
    // The plan is still the benefit-package visit's business.
    expect(details).not.toMatch(/occupied\s+insp|Basic Plan/i);
    const read = parseVisitDetails(details);
    expect(read.services).toMatchObject({ filterChange: true, pestControl: true, fleaTreatment: false, occupiedInspection: false });
    expect(read.filters).toEqual([{ size: '20x25x1', quantity: 2, location: 'Hallway', media: false }]);
    expect(read.tenants).toEqual([{ unit: null, name: 'Alex Doe', phones: ['(281) 555-0103'] }]);
    // Asked for first, as a bullet, so the office's numbered steps keep their numbers.
    expect(read.completionInstructions[0]).toBe(
      'Mark the filter change and pest control done or not done in the Texas Renters inspection app before submitting.',
    );
    expect(details.endsWith(COMPLETION_BLOCKS[type].slice(1).join('\n'))).toBe(true);
  });

  it('names a lone service on a line the parser still finds, with the inspection after it', () => {
    const details = jobberBookingText(
      input({ services: { filterChange: false, pestControl: true, fleaTreatment: false } }),
      visit('HVAC'),
    ).visitDetails;
    expect(details.split('\n')[0]).toBe('Pest Control + HVAC Inspection');
    expect(parseVisitDetails(details).services).toMatchObject({ filterChange: false, pestControl: true });
    expect(details).toContain('• Mark the pest control done or not done in the Texas Renters inspection app before submitting.');
  });

  it("keeps the office's numbering on a move-in, with the app where Inspect Cloud was", () => {
    expect(COMPLETION_BLOCKS.MOVE_IN).toContain('2. Submit it in the Texas Renters inspection app.');
    expect(COMPLETION_BLOCKS.BACK_TO_MARKET).toContain('3. Place Sign, Supra, and Lockbox');
  });

  it('checks filter sizes wherever the filter change is booked, and nowhere else', () => {
    expect(jobberBookingProblems(input())).toEqual(['"UPDATE" is not a filter size like 20x25x1.']);
    expect(jobberBookingProblems(input({ services: { ...noServices, pestControl: true } }))).toEqual([]);
  });

  it('books the five inspection types and nothing else', () => {
    expect(['OCCUPIED', 'MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET', 'HVAC'].every(isBookableInspectionType)).toBe(true);
    expect(['SUPRA_LOCKBOX_PLACEMENT', 'ROOF', 'AC_FILTER_DELIVERY', null].some(isBookableInspectionType)).toBe(false);
  });
});
