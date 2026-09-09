import { describe, expect, it } from 'vitest';

import {
  STANDARD_LAYOUT_SOURCE,
  STANDARD_PROPERTY_LAYOUT,
  layoutAreasFor,
  standardLayoutSuperseded,
} from '../src/contracts/standard-layout.js';

const template = (id: string) => ({ id, source: STANDARD_LAYOUT_SOURCE });
const imported = (id: string) => ({ id, source: 'IMPORTED_REPORT' });
const extracted = (id: string) => ({ id, source: 'AI_FLOOR_PLAN' });
const byTechnician = (id: string) => ({ id, source: 'TECHNICIAN' });
const byAdmin = (id: string) => ({ id, source: 'MANUAL' });

/**
 * The collision this rule exists for:
 *
 * An occupied visit seeds "Main Bedroom". A move-in report is imported later
 * and creates "Bedroom 1" — the import matches existing areas by normalised
 * name, and those two do not match. Both are approved, both belong to the
 * property, and the import's cleanup only deletes `InspectionArea` rows on the
 * inspection it is importing. So the next move-out walked about twenty-five
 * rooms instead of twelve.
 */
describe('when the standard layout is superseded', () => {
  it('stands aside for an imported report', () => {
    const areas = [template('a'), template('b'), imported('c')];
    expect(standardLayoutSuperseded(areas)).toBe(true);
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['c']);
  });

  it('stands aside for an extracted floor plan', () => {
    const areas = [template('a'), extracted('c')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['c']);
  });

  it('keeps additions made on top of the real layout', () => {
    // A technician's hall closet and an administrator's shed belong to the
    // imported layout, not to the template that preceded it.
    const areas = [template('a'), imported('b'), byTechnician('c'), byAdmin('d')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['b', 'c', 'd']);
  });
});

describe('when it is not', () => {
  it('is not superseded by a room a technician added', () => {
    /**
     * The failure the `WHOLE_LAYOUT_SOURCES` distinction exists to prevent. A
     * technician who finds a hall closet on an occupied visit is *adding to*
     * the layout; reading that as a replacement would drop the twelve standard
     * rooms from the next inspection because somebody recorded a thirteenth.
     */
    const areas = [...STANDARD_PROPERTY_LAYOUT.map((_, i) => template(`t${i}`)), byTechnician('x')];
    expect(standardLayoutSuperseded(areas)).toBe(false);
    expect(layoutAreasFor(areas)).toHaveLength(STANDARD_PROPERTY_LAYOUT.length + 1);
  });

  it('is not superseded by an administrator adding one area by hand', () => {
    const areas = [template('a'), byAdmin('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });

  it('returns a template-only layout untouched', () => {
    const areas = [template('a'), template('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });

  it('returns a real layout untouched', () => {
    const areas = [imported('a'), imported('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });

  it('says nothing about an empty property', () => {
    // An empty answer here is what triggers seeding in the first place, so it
    // must not be mistaken for "superseded".
    expect(standardLayoutSuperseded([])).toBe(false);
    expect(layoutAreasFor([])).toEqual([]);
  });

  it('tolerates an area whose source was never recorded', () => {
    // Older rows predate the column's documented values. Absent is not a whole
    // layout, and it is not the template either, so it simply survives.
    const areas = [{ id: 'a', source: null }, template('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });
});
