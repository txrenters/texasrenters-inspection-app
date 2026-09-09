import { describe, expect, it } from 'vitest';

import {
  NON_ROOM_SOURCES,
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

/**
 * The names are the office's, read off a real occupied inspection: 14547
 * Gleaming Rose Dr, walked by Moses Rodriguez on 2026-09-08 under their own
 * "Occupied Inspection" template.
 *
 * Not cosmetic. A report import matches existing areas by **normalised name**,
 * so a template that calls a room something the office does not creates a
 * duplicate rather than filling in the room it meant — which is the collision
 * `standardLayoutSuperseded` exists to contain, made needlessly likely.
 */
describe('the standard layout uses the office’s own room names', () => {
  const names = STANDARD_PROPERTY_LAYOUT.map((area) => area.name);

  it.each([
    ['Main Bedroom'],
    ['Main Bathroom'],
    ['Bedroom 2'],
    ['Bathroom 2'],
    ['Bedroom 3'],
    ['Kitchen'],
    ['Laundry'],
    ['Entrance'],
    ['Garage/Carport'],
    ['Front Exterior'],
    ['Rear Exterior'],
    ['Code & Cut Offs'],
  ])('has a heading the report also has: %s', (name) => {
    expect(names).toContain(name);
  });

  it.each([['Second Bedroom'], ['Second Bathroom'], ['Third Bedroom'], ['Garage'], ['Exterior']])(
    'no longer guesses at %s',
    (guess) => {
      expect(names).not.toContain(guess);
    },
  );

  it('keeps the required set to rooms every rental has', () => {
    // An occupied visit counts only its required areas, so anything a property
    // might not have belongs in the optional tail — otherwise a one-bedroom
    // house cannot be finished without skipping rooms it never had.
    expect(STANDARD_PROPERTY_LAYOUT.filter((a) => a.isRequired).map((a) => a.name)).toEqual([
      'Living Room',
      'Kitchen',
      'Main Bedroom',
      'Main Bathroom',
      'Front Exterior',
    ]);
  });

  it('gives every area a name of its own', () => {
    // The unique index is on (propertyId, unitId, floorId, name), so a repeat
    // would silently write one row fewer than the list has entries.
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The HVAC placeholder is not a layout.
 *
 * `hvacSystemArea` attaches one synthetic approved area — "HVAC System",
 * `isRequired: false` — to a property the first time an HVAC visit is
 * scheduled, standing in for the equipment so the evidence, checklist and
 * finding tables all have the area they require. Nothing about it is shown to
 * anybody on an HVAC visit.
 *
 * But it is APPROVED, so every "does this property have a layout?" answer
 * counted it. A property that had ever had an HVAC visit looked laid out, and
 * an occupied inspection scheduled there skipped seeding and reached the
 * technician holding exactly one area — called HVAC System — and no rooms.
 * Two production inspections landed in that state on 2026-09-10.
 */
describe('an equipment area is not a room', () => {
  const system = (id: string) => ({ id, source: 'SYSTEM' });

  it('leaves a property whose only approved area is the HVAC placeholder with no layout', () => {
    // Empty is what triggers seeding, which is exactly what should happen here.
    expect(layoutAreasFor([system('hvac')])).toEqual([]);
  });

  it('drops it from a real layout rather than walking it as a room', () => {
    const areas = [system('hvac'), imported('a'), imported('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });

  it('drops it from a standard-template layout too', () => {
    const areas = [system('hvac'), template('a'), template('b')];
    expect(layoutAreasFor(areas).map((area) => area.id)).toEqual(['a', 'b']);
  });

  it('cannot tip the supersession answer, which is only ever about rooms', () => {
    /**
     * Order matters inside `layoutAreasFor`: equipment is filtered before the
     * template rule is asked. `SYSTEM` is not in `WHOLE_LAYOUT_SOURCES`, so it
     * could not supersede anything today — but asking the question of a list
     * that still contained it would be one refactor away from doing so.
     */
    expect(standardLayoutSuperseded([system('hvac')])).toBe(false);
    expect(layoutAreasFor([system('hvac'), template('a')]).map((a) => a.id)).toEqual(['a']);
  });

  it('is unaffected by an HVAC visit, which never reads this', () => {
    // An HVAC visit is scoped HVAC_SYSTEM and resolves its equipment area
    // through `hvacSystemArea`, so excluding it here takes nothing away from
    // the one kind of visit that wants it.
    expect(NON_ROOM_SOURCES).toContain('SYSTEM');
  });
});
