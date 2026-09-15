import { describe, expect, it } from 'vitest';

import { parseVisitDetails } from '../src/index.js';

/**
 * Details as coordinators actually write them on Jobber visits.
 *
 * Every shape here was seen on the 350 live occupied visits read 2026-09-15.
 * The people, phone numbers and codes are invented.
 */

const COMPLETION = `Instruction for completion
• Indicate in the notes which services were completed by using the corresponding numbers:
 1.Filter Change
 2.Pest Control
 3.HVAC / Occupied Inspection
Example: “1, 2” → indicates that only Filter Change and Pest Control were completed.
• Note the size of any filters that were not replaced and/or filters that are not listed.
• Check for any potential repairs and create a work order if needed.
Note: If the property is inaccessible, please do the outside pest control only do not leave/drop the filters at their doors.`;

describe('the standard occupied visit', () => {
  const details = parseVisitDetails(`Filter Change: 20x25x1; 12x12x1 + Pest Control + Occupied Inspection (Basic Plan - Opted Ou HVAC Plan)

Make sure to contact tenants that you are on your way.
Tenant: Jane Q Sample (832) 555-0101 \t(713) 555-0102

Note: the AC unit outside had its cover open please close it.

${COMPLETION}`);

  it('reads the services and the filters to bring', () => {
    expect(details.services).toEqual({
      filterChange: true,
      pestControl: true,
      fleaTreatment: false,
      occupiedInspection: true,
      other: [],
    });
    expect(details.filters).toEqual([
      { size: '20x25x1', quantity: 1, location: null, media: false },
      { size: '12x12x1', quantity: 1, location: null, media: false },
    ]);
  });

  it('reads the plan, including the way one coordinator types "Opted Out"', () => {
    expect(details.plan).toEqual({ tier: 'Basic', hvacOptedOut: true });
  });

  it('reads who to call, and that they should be called first', () => {
    expect(details.contactTenantsBeforeArrival).toBe(true);
    expect(details.tenants).toEqual([
      { unit: null, name: 'Jane Q Sample', phones: ['(832) 555-0101', '(713) 555-0102'] },
    ]);
  });

  it('keeps the note, and the completion steps one per line', () => {
    expect(details.notes).toEqual(['Note: the AC unit outside had its cover open please close it.']);
    expect(details.completionInstructions[0]).toBe(
      'Indicate in the notes which services were completed by using the corresponding numbers',
    );
    expect(details.completionInstructions).toContain('3.HVAC / Occupied Inspection');
    expect(details.completionInstructions.at(-1)).toMatch(/^Note: If the property is inaccessible/);
    expect(details.occupiedInspectionNotNeeded).toBe(false);
  });

  it('always carries the text as written', () => {
    expect(details.raw.startsWith('Filter Change: 20x25x1; 12x12x1')).toBe(true);
  });
});

describe('filters written the other ways', () => {
  it('reads a quantity and a media filter', () => {
    const details = parseVisitDetails(
      'Filter Change: (2 pcs) 20x25x4 MEDIA + Pest Control + Occupied Inspection (BX Plan - Opted Out HVAC Plan)',
    );
    expect(details.filters).toEqual([{ size: '20x25x4', quantity: 2, location: null, media: true }]);
    expect(details.plan).toEqual({ tier: 'BX', hvacOptedOut: true });
  });

  it('reads where each filter goes, and keeps a filter note with no size', () => {
    const details = parseVisitDetails(
      'Filter Change: 12 x 24 x 1 in upstairs hallway; 16x25x1 (3rd flr); 12 x 36; Update if found more filter register + Pest Control + Occupied Inspection',
    );
    expect(details.filters).toEqual([
      { size: '12x24x1', quantity: 1, location: 'upstairs hallway', media: false },
      { size: '16x25x1', quantity: 1, location: '3rd flr', media: false },
      { size: '12x36', quantity: 1, location: null, media: false },
    ]);
    expect(details.filterNotes).toEqual(['Update if found more filter register']);
  });

  it('reads filters that were also listed with "+"', () => {
    const details = parseVisitDetails(
      'Filter Change: 1 (20x25x1) - master bedroom + 1 (16x25x1) downstairs + Pest Control + Occupied Inspection',
    );
    expect(details.filters.map((filter) => [filter.size, filter.location])).toEqual([
      ['20x25x1', 'master bedroom'],
      ['16x25x1', 'downstairs'],
    ]);
    expect(details.services.other).toEqual([]);
  });

  it('reads "Filter Change;" and several sizes with no separator between them', () => {
    const details = parseVisitDetails(
      'Filter Change; 20x25x1: 12x24x1; Aprilair 20x25x4 or 20x30x1 + Pest Control + Occupied Inspection',
    );
    expect(details.services.filterChange).toBe(true);
    expect(details.filters.map((filter) => filter.size)).toEqual(['20x25x1', '12x24x1', '20x25x4', '20x30x1']);
    // "or" and a brand say more than the sizes do, so the words stay visible.
    expect(details.filterNotes).toEqual(['Aprilair 20x25x4 or 20x30x1']);
  });

  it('reads a nested plan', () => {
    expect(
      parseVisitDetails('Filter Change: 20x20x1 + Pest Control + Occupied Inspection (Premium (w/o HVAC) - Opted out HVAC plan)').plan,
    ).toEqual({ tier: 'Premium', hvacOptedOut: true });
  });
});

describe('a visit covering several units', () => {
  const details = parseVisitDetails(`Filter Change: 20x20x1 (N Main); 14 x 18 x 1(N Main); 16x20x1 (1/2 N Main); reusable window AC unit (no need to change - 1/4 N Main) + Pest Control + Occupied Inspection

101 N Main St - Tenant: Alex Doe (281) 555-0103
101 1/2 N Main St - Tenant: Sam Roe (281) 555-0104 \t(281) 555-0105`);

  it('reads the filters per unit', () => {
    expect(details.filters.map((filter) => filter.location)).toEqual(['N Main', 'N Main', '1/2 N Main']);
    expect(details.filterNotes).toEqual(['reusable window AC unit (no need to change - 1/4 N Main)']);
  });

  it('reads a tenant per unit', () => {
    expect(details.tenants).toEqual([
      { unit: '101 N Main St', name: 'Alex Doe', phones: ['(281) 555-0103'] },
      { unit: '101 1/2 N Main St', name: 'Sam Roe', phones: ['(281) 555-0104', '(281) 555-0105'] },
    ]);
  });

  it('is not mistaken for "no occupied inspection needed" by the filter note', () => {
    expect(details.services.occupiedInspection).toBe(true);
    expect(details.occupiedInspectionNotNeeded).toBe(false);
  });
});

describe('what a technician has to know before arriving', () => {
  const details = parseVisitDetails(`Filter Change: 20x30x1 + Pest Control + Occupied Inspection (Basic Plan - Opted out HVAC Plan)

Tenant has a very large dog and has no crates at this time

Chris Poe (409) 555-0106
Gate Code: 4321 for tenant, visitors press #8765

Tenant message: "please give me 30 minutes warning, I will leave the front door unlocked"`);

  it('reads a contact line with no "Tenant:" label', () => {
    expect(details.tenants).toEqual([{ unit: null, name: 'Chris Poe', phones: ['(409) 555-0106'] }]);
    expect(details.contactTenantsBeforeArrival).toBe(false);
  });

  it('puts the gate code where it can be found, and not a door mentioned in passing', () => {
    expect(details.accessNotes).toEqual(['Gate Code: 4321 for tenant, visitors press #8765']);
    expect(details.notes).toEqual([
      'Tenant has a very large dog and has no crates at this time',
      'Tenant message: "please give me 30 minutes warning, I will leave the front door unlocked"',
    ]);
  });
});

describe('a visit that says no inspection is needed', () => {
  it('reads it from the services line, where the words still match the sync', () => {
    const details = parseVisitDetails(
      'Filter Change: Update Filter sizes; if filters found dirty, please buy necessary filters from Home Depot. + Pest Control + No need Occupied inspection since tenant just moved into the property',
    );
    expect(details.occupiedInspectionNotNeeded).toBe(true);
    expect(details.services.occupiedInspection).toBe(false);
    expect(details.services.pestControl).toBe(true);
    expect(details.filters).toEqual([]);
    expect(details.filterNotes).toEqual([
      'Update Filter sizes',
      'if filters found dirty',
      'please buy necessary filters from Home Depot.',
    ]);
  });

  it('reads "no occupied inspection needed" as well', () => {
    const details = parseVisitDetails(
      'Filter Change: 14x25x1 + Pest Control\n\nTenant just moved in 9/1 no occupied inspection needed.',
    );
    expect(details.occupiedInspectionNotNeeded).toBe(true);
  });

  it('recognises the inspection however it was typed', () => {
    expect(
      parseVisitDetails('Filter Change: 20x25x1 + Pest Control + Occuied Inspection (Standard Plan)').services
        .occupiedInspection,
    ).toBe(true);
  });

  it('is not fooled by the completion steps, which name the inspection on every visit', () => {
    // "3.HVAC / Occupied Inspection" is in the office's standing block, so the
    // services line is the only place that says whether one was booked.
    const details = parseVisitDetails(`Filter Change: 20x25x5 + Pest Control\n\n${COMPLETION}`);
    expect(details.services.occupiedInspection).toBe(false);
    expect(details.occupiedInspectionNotNeeded).toBe(false);
  });

  it('reads it from a note too', () => {
    const details = parseVisitDetails(
      'Filter Change: 12 x 36 + Pest Control + Occupied Inspection\n\nTenant just moved in on 7/31/2026 no need for Occupied Inspection at this time.',
    );
    expect(details.services.occupiedInspection).toBe(true);
    expect(details.occupiedInspectionNotNeeded).toBe(true);
  });
});

describe('everything else', () => {
  it('keeps a note written before the services on the same line', () => {
    const details = parseVisitDetails(
      'Coordinate with Nathan on how to do the pest control and flea treatment Filter Change: 12x24x1; 16x25x1 + Pest Control + Flea Treatment',
    );
    expect(details.notes).toEqual(['Coordinate with Nathan on how to do the pest control and flea treatment']);
    expect(details.services).toMatchObject({ filterChange: true, pestControl: true, fleaTreatment: true, occupiedInspection: false });
    expect(details.filters).toHaveLength(2);
  });

  it('keeps a phone number inside a note as part of the note', () => {
    const details = parseVisitDetails(
      'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\n\nOffice Note: if nobody answers, call the leasing office at 832-555-0100 before leaving.',
    );
    expect(details.tenants).toEqual([]);
    expect(details.notes).toEqual([
      'Office Note: if nobody answers, call the leasing office at 832-555-0100 before leaving.',
    ]);
  });

  it('keeps a tenant message that carries a number as a message, not a name', () => {
    const details = parseVisitDetails(
      'Filter Change: 20x25x1 + Pest Control + Occupied Inspection\n\nThere is a mouse in the house. Can you please put traps out (832) 555-0110',
    );
    expect(details.tenants).toEqual([]);
    expect(details.notes).toEqual(['There is a mouse in the house. Can you please put traps out (832) 555-0110']);
  });

  it('reads the phone formats coordinators use', () => {
    const details = parseVisitDetails('Tenant: Pat Moe +1 832 555 0107 832-555-0108 (832)555-0109');
    expect(details.tenants[0]?.phones).toEqual(['+1 832 555 0107', '832-555-0108', '(832)555-0109']);
    expect(details.tenants[0]?.name).toBe('Pat Moe');
  });

  it('reads a move-in or back-to-market visit as completion steps and nothing else', () => {
    const details = parseVisitDetails(
      'Instruction Completion\nNote: Pick up sign/supra/lockbox at the office\n1. Conduct BTM Inspection\n2. Upload to Inspect cloud\n3. Place Sign, Supra, and Lockbox',
    );
    expect(details.completionInstructions).toEqual([
      'Note: Pick up sign/supra/lockbox at the office',
      '1. Conduct BTM Inspection',
      '2. Upload to Inspect cloud',
      '3. Place Sign, Supra, and Lockbox',
    ]);
    expect(details.accessNotes).toEqual([]);
    expect(details.services.filterChange).toBe(false);
  });

  it('reads pest control and an inspection with no filter change', () => {
    const details = parseVisitDetails('Pest Control + Occupied Inspection (Standard Plan - Opted Out HVAC Plan)');
    expect(details.services).toMatchObject({ filterChange: false, pestControl: true, occupiedInspection: true });
    expect(details.plan).toEqual({ tier: 'Standard', hvacOptedOut: true });
  });

  it('returns an empty reading for no details at all', () => {
    for (const empty of [null, undefined, '', '   \n ']) {
      const details = parseVisitDetails(empty);
      expect(details.raw).toBe('');
      expect(details.notes).toEqual([]);
      expect(details.plan).toBeNull();
    }
  });
});
