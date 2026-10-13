import { describe, expect, it } from 'vitest';

import { parseVisitDetails, withoutVisitServices } from '../src/contracts/visit-details';
import { reportableServices } from '../src/contracts/visit-services';

/**
 * The second inspection a Jobber visit books (2026-10-13) keeps the visit's
 * Details without its services line: the filter change and pest control are
 * answered once, on the first inspection, not twice.
 */
describe('a visit’s Details without its services', () => {
  const details = [
    'Filter Change: 20x25x1 (2 pcs) + Pest Control + HVAC Inspection + Occupied Inspection',
    '',
    'Call or text tenant prior to arrival',
    'Tenant: Jane Example (555) 010-0199',
    'Lockbox code 1234',
    '',
    'Inspect the recently completed plumbing work.',
  ].join('\n');

  it('reads as the same visit with nothing to answer', () => {
    const full = parseVisitDetails(details);
    const rest = parseVisitDetails(withoutVisitServices(details));

    expect(reportableServices(full).length).toBeGreaterThan(0);
    expect(reportableServices(rest)).toEqual([]);
    expect(rest.filters).toEqual([]);
    expect(rest.services.occupiedInspection).toBe(false);
    // Everything else the technician needs is still there.
    expect(rest.tenants).toEqual(full.tenants);
    expect(rest.accessNotes).toEqual(full.accessNotes);
    expect(rest.notes).toEqual(full.notes);
    expect(rest.contactTenantsBeforeArrival).toBe(full.contactTenantsBeforeArrival);
  });

  it('keeps a note written in front of the services on the same line', () => {
    const text = 'Filter Drop: 16x20x1; 20x25x1 + HVAC inspection + Occupied inspection';
    expect(withoutVisitServices(text)).toBe('Filter Drop: 16x20x1; 20x25x1 + HVAC inspection +');
    expect(parseVisitDetails(withoutVisitServices(text)).services.occupiedInspection).toBe(false);
  });

  it('leaves Details with no services line as they were, and nothing as nothing', () => {
    expect(withoutVisitServices('Gate code 4411\nDog in the yard')).toBe('Gate code 4411\nDog in the yard');
    expect(withoutVisitServices(null)).toBeNull();
    expect(withoutVisitServices('Filter Change: 20x25x1')).toBeNull();
  });
});
