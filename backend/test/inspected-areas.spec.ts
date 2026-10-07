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
  { name: 'Sign, supra and lockbox', source: 'SYSTEM' },
];

type Area = { name: string; source: string; completionStatus?: string };
type Clause = {
  propertyArea: { source: { in: string[] }; name?: string | { in: string[] } | { not: string } };
  completionStatus?: { not: string };
};

/** What the database would answer for one area, reading the filter as Prisma does. */
function matches(where: ReturnType<typeof inspectedAreaWhere>, area: Area) {
  const clauses = ([] as Clause[]).concat(where.NOT as Clause | Clause[]);
  const hits = (clause: Clause) => {
    const { source, name } = clause.propertyArea;
    const status = area.completionStatus ?? 'PENDING';
    return (
      source.in.includes(area.source) &&
      (name === undefined ||
        (typeof name === 'string'
          ? name === area.name
          : 'not' in name
            ? name.not !== area.name
            : name.in.includes(area.name))) &&
      (!clause.completionStatus || status !== clause.completionStatus.not)
    );
  };
  return !clauses.some(hits);
}

describe('the areas an inspection inspects', () => {
  it("lists a back-to-market visit's sign, supra and lockbox, and no other visit's", () => {
    // Moses, 2026-10-08: every back-to-market visit ends there. A system area,
    // so a move-out or an occupied visit to the same property never asks it.
    const lockbox = { name: 'Sign, supra and lockbox', source: 'SYSTEM' };
    expect(isInspectedArea(InspectionType.BACK_TO_MARKET, lockbox)).toBe(true);
    for (const type of [InspectionType.OCCUPIED, InspectionType.MOVE_OUT, InspectionType.MOVE_IN])
      expect(isInspectedArea(type, lockbox)).toBe(false);
    // The rest of the system areas stay off a back-to-market visit.
    expect(isInspectedArea(InspectionType.BACK_TO_MARKET, { name: 'AC filters', source: 'SYSTEM' })).toBe(false);
  });

  it.each(Object.values(InspectionType))('agree in the database and in memory for %s', (type) => {
    const where = inspectedAreaWhere(type);
    for (const area of [...AREAS, { name: 'Filters', source: 'SYSTEM', completionStatus: 'COMPLETED' }])
      expect(matches(where, area)).toBe(isInspectedArea(type, area));
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
    expect(names).toEqual(expect.arrayContaining(['A/C unit', 'HVAC System']));
    expect(names).not.toEqual(expect.arrayContaining(['AC filters']));
    expect(names).not.toContain('Pest control');
  });

  /** Moses, 2026-10-01: scored on the AC filter change now. */
  it('leaves out an HVAC Filters section nobody submitted, and keeps one that was', () => {
    const filters = { name: 'Filters', source: 'SYSTEM' };
    const rows = [
      { id: 'open', completionStatus: 'PENDING', propertyArea: filters },
      { id: 'walked', completionStatus: 'COMPLETED', propertyArea: filters },
    ];
    expect(inspectedAreas(InspectionType.HVAC, rows).map((row) => row.id)).toEqual(['walked']);
  });
});
