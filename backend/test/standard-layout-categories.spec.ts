import { AreaCategory, AreaEnvironment } from '@prisma/client';
import { STANDARD_PROPERTY_LAYOUT } from '@texasrenters/shared';

/**
 * The standard layout only names categories the database actually has.
 *
 * This test exists because it was missing. `StandardLayoutArea.category` was
 * typed `string | null`, so four categories that do not exist — LIVING,
 * KITCHEN, BEDROOM, BATHROOM — went through review, typecheck, 155 shared
 * tests, 1079 backend tests, a release and a production deploy. Nothing could
 * have caught them: the type accepted any string, and the backend cast it to
 * `AreaCategory` on the way to Prisma, which silenced the one check that would
 * have failed.
 *
 * It surfaced on the first property the seeder touched, as
 * `Invalid value for argument 'category'. Expected AreaCategory.` — and not
 * only in the backfill: `ensureStandardLayout` runs on every occupied
 * inspection created at a property with no layout, so inspection creation was
 * failing in production for exactly the case the feature was written for.
 *
 * It lives in `backend` rather than `shared` on purpose. `shared` deliberately
 * does not depend on `@prisma/client`, so it cannot see the enum and cannot
 * check itself. This is the seam where the two can be compared, and a contract
 * that names database values without ever meeting the database is precisely
 * the kind that drifts.
 */
describe('every value the standard layout names exists in the schema', () => {
  it.each(STANDARD_PROPERTY_LAYOUT.map((area) => [area.name, area.category] as const))(
    '%s has a real category (%s)',
    (_name, category) => {
      // Null is allowed and means "the checklist should read the name".
      if (category === null) return;
      expect(Object.values(AreaCategory)).toContain(category);
    },
  );

  it.each(STANDARD_PROPERTY_LAYOUT.map((area) => [area.name, area.environment] as const))(
    '%s has a real environment (%s)',
    (_name, environment) => {
      // The same class of bug, one field over, and equally uncaught until now.
      expect(Object.values(AreaEnvironment)).toContain(environment);
    },
  );

  it('sends ordinary rooms to the name rules rather than mis-categorising them', () => {
    /**
     * `checklistTemplateFor` treats a set category as authoritative and only
     * reads the name when the category says nothing useful. `INDOOR_ROOM` has
     * no entry in `CATEGORY_ALIASES`, so it falls through — which is how "Main
     * Bathroom" reaches the bathroom list without a BATHROOM category existing.
     *
     * Pinned because the fix looks like a downgrade. Somebody tidying this
     * later might reach for a "more specific" category and reintroduce exactly
     * the invented values that broke production.
     */
    const rooms = ['Living Room', 'Kitchen', 'Main Bedroom', 'Main Bathroom', 'Bedroom 2'];
    for (const name of rooms) {
      const area = STANDARD_PROPERTY_LAYOUT.find((entry) => entry.name === name);
      expect(area?.category).toBe(AreaCategory.INDOOR_ROOM);
    }
  });

  it('sets a category only where the enum knows something the name does not', () => {
    const byName = (name: string) =>
      STANDARD_PROPERTY_LAYOUT.find((area) => area.name === name)?.category;
    expect(byName('Hallway')).toBe(AreaCategory.HALLWAY);
    expect(byName('Laundry')).toBe(AreaCategory.UTILITY);
    // GARAGE has to be explicit: `checklistTemplateFor` once answered on the
    // environment alone, and a semi-outdoor garage was asked about its lawn.
    expect(byName('Garage/Carport')).toBe(AreaCategory.GARAGE);
  });
});
