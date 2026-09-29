import { InspectionType } from '@prisma/client';
import { isInspectedArea } from '@texasrenters/shared';

import { inspectedAreas, inspectedAreaWhere } from '../src/common/inspected-areas';

/**
 * The areas an inspection inspects, asked two ways: as a database filter for
 * the queries that count or list them, and over areas already loaded. The
 * office (2026-09-29): "inspection is purely for inspection" -- the filter
 * change's photo area is attached to the inspection, but is not one of its
 * areas, in the phone, the console, the report or the comparison.
 */

const AREAS = [
  { name: 'Kitchen', source: 'AI_FLOOR_PLAN' },
  { name: 'Shed', source: 'TECHNICIAN' },
  { name: 'Bedroom 3', source: 'STANDARD_TEMPLATE' },
  { name: 'AC filters', source: 'SYSTEM' },
  { name: 'Pest control', source: 'SYSTEM' },
  { name: 'Flea treatment', source: 'SYSTEM' },
  { name: 'Filters', source: 'SYSTEM' },
  { name: 'A/C unit', source: 'SYSTEM' },
  { name: 'HVAC System', source: 'SYSTEM' },
];

/** What the database would answer for one area, reading the filter as Prisma does. */
function matches(where: ReturnType<typeof inspectedAreaWhere>, area: { name: string; source: string }) {
  const excluded = (where.NOT as { propertyArea: { source: { in: string[] }; name?: { in: string[] } } })
    .propertyArea;
  const hit = excluded.source.in.includes(area.source) && (!excluded.name || excluded.name.in.includes(area.name));
  return !hit;
}

describe('the areas an inspection inspects', () => {
  it.each(Object.values(InspectionType))('agree in the database and in memory for %s', (type) => {
    const where = inspectedAreaWhere(type);
    for (const area of AREAS) expect(matches(where, area)).toBe(isInspectedArea(type, area));
  });

  it('leaves the filter change out of a move-out, and keeps its rooms', () => {
    const rows = AREAS.map((propertyArea, index) => ({ id: `area-${index}`, propertyArea }));
    expect(inspectedAreas(InspectionType.MOVE_OUT, rows).map((row) => row.propertyArea.name)).toEqual([
      'Kitchen',
      'Shed',
      'Bedroom 3',
    ]);
  });

  it('keeps an HVAC visit’s own sections, and still leaves the service photo areas out', () => {
    const rows = AREAS.map((propertyArea, index) => ({ id: `area-${index}`, propertyArea }));
    const names = inspectedAreas(InspectionType.HVAC, rows).map((row) => row.propertyArea.name);
    expect(names).toEqual(expect.arrayContaining(['Filters', 'A/C unit', 'HVAC System']));
    expect(names).not.toEqual(expect.arrayContaining(['AC filters']));
    expect(names).not.toContain('Pest control');
  });
});
