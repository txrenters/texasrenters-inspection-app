import { dialable, filterLine, visitDetailsView } from '../src/utils/visit-details-view';

/**
 * What the technician walking an occupied visit sees of the Jobber Details:
 * the filters to bring, who to call, how to get in. They used to open Jobber on
 * the same phone for all of it. People, numbers and codes here are invented.
 */

const DETAILS = `Filter Change: (2 pcs) 20x25x4 MEDIA; 12x24x1 in upstairs hallway + Pest Control + Occupied Inspection (Basic Plan - Opted Out HVAC Plan)

Make sure to contact tenants that you are on your way.
Tenant: Jane Q Sample (832) 555-0101 +1 713 555 0102

Gate Code: 4321 for tenant

Instruction for completion
• Indicate in the notes which services were completed by using the corresponding numbers:`;

describe('the visit details on the phone', () => {
  const view = visitDetailsView(DETAILS)!;

  it('names the services and the filters to bring', () => {
    expect(view.services).toEqual(['Filter change', 'Pest control', 'Occupied inspection']);
    expect(view.filterChange).toBe(true);
    expect(view.filters).toEqual(['20x25x4 × 2 · media', '12x24x1 · upstairs hallway']);
  });

  it('gives each phone number something a call or a text can dial', () => {
    expect(view.contactBeforeArrival).toBe(true);
    expect(view.tenants).toEqual([
      {
        key: '0-Jane Q Sample',
        name: 'Jane Q Sample',
        unit: null,
        phones: [
          { display: '(832) 555-0101', dial: '8325550101' },
          { display: '+1 713 555 0102', dial: '+17135550102' },
        ],
      },
    ]);
  });

  it('keeps how to get in, the completion steps and the text as written', () => {
    expect(view.accessNotes).toEqual(['Gate Code: 4321 for tenant']);
    expect(view.completionSteps).toEqual([
      'Indicate in the notes which services were completed by using the corresponding numbers',
    ]);
    expect(view.raw.startsWith('Filter Change: (2 pcs)')).toBe(true);
    expect(view.inspectionNotNeeded).toBe(false);
  });

  it('says when the details say no inspection is needed', () => {
    expect(
      visitDetailsView('Filter Change: 12 x 36 + Pest Control\n\nTenant just moved in, no need for Occupied Inspection at this time.')
        ?.inspectionNotNeeded,
    ).toBe(true);
  });

  it('is nothing at all for an inspection with no Jobber details', () => {
    expect(visitDetailsView(null)).toBeNull();
    expect(visitDetailsView('  ')).toBeNull();
  });

  it('reads a filter the way a technician says it', () => {
    expect(filterLine({ size: '16x25x1', quantity: 1, location: null, media: false })).toBe('16x25x1');
    expect(dialable('(409) 555-0106 ext')).toBe('4095550106');
  });
});
