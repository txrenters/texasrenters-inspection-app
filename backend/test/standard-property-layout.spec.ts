import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AreaChecklistItemKind, InspectionType, PropertyAreaStatus } from '@prisma/client';
import { STANDARD_LAYOUT_SOURCE, STANDARD_PROPERTY_LAYOUT } from '@texasrenters/shared';

import {
  type InspectionCreationClient,
  type InspectionPlan,
  insertInspection,
} from '../src/admin/inspection-creation';

/**
 * A property with no approved layout gets the standard one.
 *
 * The Jobber sync names the problem in its own comment: visits arrive empty
 * "on a property with no approved plan, which is currently every property in
 * this portfolio". So an occupied inspection reached the technician with no
 * rooms and they typed them in — Main Bedroom, Main Bathroom, Second Bedroom,
 * Second Bathroom — at every property, on every visit, inside the fifteen
 * minutes the office allows for the whole walk.
 *
 * The templating mechanism was never missing. It had nothing in it.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';

function client({ seeded = STANDARD_PROPERTY_LAYOUT.map((area, index) => ({
  id: `area-${index}`,
  name: area.name,
  category: area.category,
  environment: area.environment,
})) } = {}) {
  const areaCreateMany = jest.fn().mockResolvedValue({ count: seeded.length });
  const checklistCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const findMany = jest.fn().mockResolvedValue(seeded);
  const upsert = jest.fn().mockResolvedValue({ id: 'property-1' });
  const create = jest.fn().mockResolvedValue({ id: 'inspection-1' });
  return {
    tx: {
      property: { upsert },
      propertyArea: { createMany: areaCreateMany, findMany },
      areaChecklistItem: { createMany: checklistCreateMany },
      inspection: { create },
    } as unknown as InspectionCreationClient,
    areaCreateMany,
    checklistCreateMany,
    upsert,
    create,
  };
}

function plan(inspectionType: InspectionType, scopedAreas: { id: string }[] = []): InspectionPlan {
  return {
    organizationId: ORGANIZATION,
    inspectionType,
    property: {
      id: 'building-1',
      name: 'A property',
      addressLine1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    },
    unit: { id: 'unit-1' },
    lease: null,
    baselineInspectionId: null,
    scheduledAt: new Date('2026-09-09'),
    scheduledStartAt: null,
    scheduledEndAt: null,
    technicianWillCapture: false,
    scopedAreas,
  } as unknown as InspectionPlan;
}

const details = { createdById: null } as Parameters<typeof insertInspection>[2];

describe('an occupied inspection at a property nobody has laid out', () => {
  it('writes the standard rooms and walks them', async () => {
    const { tx, areaCreateMany, create } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);

    const rows = areaCreateMany.mock.calls[0][0].data as { name: string; status: string }[];
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'Main Bedroom',
        'Main Bathroom',
        'Bedroom 2',
        'Bathroom 2',
      ]),
    );
    // The inspection actually gets them, which is the whole point.
    expect(create.mock.calls[0][0].data.areas.create).toHaveLength(STANDARD_PROPERTY_LAYOUT.length);
  });

  it('approves them, because a draft area is scoped out of every inspection', async () => {
    // The failure this avoids is subtle: areas exist, the technician sees none,
    // and nothing anywhere says why.
    const { tx, areaCreateMany } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);
    const rows = areaCreateMany.mock.calls[0][0].data as { status: string; source: string }[];
    expect(rows.every((row) => row.status === PropertyAreaStatus.APPROVED)).toBe(true);
    // And records that they are a guess, so an administrator can tell them from
    // a layout somebody actually read.
    expect(rows.every((row) => row.source === STANDARD_LAYOUT_SOURCE)).toBe(true);
  });

  it('leaves the rooms a rental might not have optional', async () => {
    // `inspectionRequiresEveryArea` is false for an occupied visit, so an
    // optional area never stands between the technician and submitting. That is
    // what makes a fixed list safe on a property it does not perfectly match.
    const { tx, areaCreateMany } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);
    const rows = areaCreateMany.mock.calls[0][0].data as { name: string; isRequired: boolean }[];
    const required = rows.filter((row) => row.isRequired).map((row) => row.name);
    expect(required).toEqual([
      'Living Room',
      'Kitchen',
      'Main Bedroom',
      'Main Bathroom',
      'Front Exterior',
    ]);
    expect(rows.find((row) => row.name === 'Bedroom 2')?.isRequired).toBe(false);
  });

  it('creates the Property row before the areas that point at it', async () => {
    // `PropertyArea.propertyId` carries a building id but keys to `Property`,
    // which is populated lazily. Creating the area first violates the foreign
    // key and takes the whole Jobber sync down with it.
    const { tx, upsert, areaCreateMany } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);
    expect(upsert).toHaveBeenCalled();
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(
      areaCreateMany.mock.invocationCallOrder[0],
    );
  });

  it('gives each room a checklist without calling a model', async () => {
    // Deterministic, from the shared table. The AI generator makes a provider
    // call, and this runs inside the creation transaction — a 60-second call
    // there is dropped by the pooler and loses the inspection with it.
    const { tx, checklistCreateMany } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED), details);
    /**
     * Not `calls[0]`. An occupied inspection also writes the organization's
     * two-question list through `ensureOccupiedChecklist`, and that one goes
     * first — so indexing by position asserted against the wrong write the
     * moment the two features met on main. Selected by kind instead, which is
     * what actually distinguishes them.
     */
    const roomWrite = checklistCreateMany.mock.calls.find(
      ([argument]) => argument.data[0]?.kind === AreaChecklistItemKind.ROOM,
    );
    const items = roomWrite![0].data as { label: string }[];
    expect(items.length).toBeGreaterThan(STANDARD_PROPERTY_LAYOUT.length);
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(['Bath, shower and taps', 'Stove, hobs and griller']),
    );
  });
});

describe('when the standard layout must not be written', () => {
  it('leaves a property that already has areas alone', async () => {
    const { tx, areaCreateMany, create } = client();
    await insertInspection(tx, plan(InspectionType.OCCUPIED, [{ id: 'real-area' }]), details);
    expect(areaCreateMany).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.areas.create).toEqual([{ propertyAreaId: 'real-area' }]);
  });

  it.each([[InspectionType.MOVE_IN], [InspectionType.MOVE_OUT]])(
    'does not guess a layout for %s',
    async (inspectionType) => {
      /**
       * Two reasons, either sufficient. The type overrides `isRequired`, so
       * every guessed room becomes mandatory and a technician at a one-bedroom
       * property has to skip the ones this list invented. And a move-out is
       * compared to its move-in area by area — seeding both ends from a guess
       * produces a comparison against rooms nobody has seen.
       *
       * They lose nothing by waiting: the layout is the property's,
       * permanently, so the first occupied visit establishes it and these
       * inherit it through the ordinary lookup.
       */
      const { tx, areaCreateMany } = client();
      await insertInspection(tx, plan(inspectionType), details);
      expect(areaCreateMany).not.toHaveBeenCalled();
    },
  );
});

/**
 * Asserted against the source, in the style of `jobber-completed-move-in.spec.ts`.
 *
 * `resolveInspectionPlan` reaches for six tables before it gets to the layout,
 * so a behavioural test here would be mostly scaffolding for one `where`
 * clause. What matters is that the clause is present, and that is what this
 * reads. The rule it feeds is unit-tested in `shared/tests/standard-layout.test.ts`.
 */
describe('the layout query', () => {
  const CREATION = readFileSync(
    join(__dirname, '..', 'src', 'admin', 'inspection-creation.ts'),
    'utf8',
  );
  const layoutWhere = CREATION.slice(
    CREATION.indexOf('const layoutWhere'),
    CREATION.indexOf('const layoutSelect'),
  );

  it('excludes archived areas', () => {
    /**
     * This filter was missing, and its absence is a plain bug: the column's own
     * comment says "archived areas drop out of active lists", and every new
     * inspection scoped them straight back in. An administrator who archived a
     * room they had merged away saw it return on the next visit with nothing on
     * screen to explain why.
     */
    expect(layoutWhere).toContain('archivedAt: null');
  });

  it('still takes only approved areas', () => {
    // The rule that predates all of this, and the one a careless edit here
    // would quietly drop: a DRAFT area belongs to nobody's inspection yet.
    expect(layoutWhere).toContain('status: PropertyAreaStatus.APPROVED');
  });

  it('reads source, because the template rule depends on it', () => {
    const layoutSelect = CREATION.slice(
      CREATION.indexOf('const layoutSelect'),
      CREATION.indexOf('const unitAreas'),
    );
    expect(layoutSelect).toContain('source: true');
  });
});
