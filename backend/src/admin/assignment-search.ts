import type { Prisma } from '@prisma/client';

/**
 * What the assignments list searches when somebody types in its box.
 *
 * **The property, not the person.** There is a technician filter two controls
 * along that answers "whose visits are these" exactly, and folding people into
 * the address box would make "Moses" return every visit he has ever been
 * assigned rather than the one property being looked for.
 *
 * Its own module because the assignments list is really two queries -- the
 * assignments themselves, and the inspections that have nobody on them -- and
 * the filter has to be identical on both. Applying it to one and forgetting the
 * other lets every unassigned visit through a search that has narrowed
 * everything else, which reads as the search being broken rather than partial.
 *
 * The page shipped with a search box wired to a handler that did nothing: the
 * comment beside it said the box was "omitted", but the no-op it was given is
 * still a function, so the toolbar drew the field and the office typed
 * addresses into a control that could not answer.
 */
export function assignmentPropertySearch(
  search: string | undefined | null,
): Prisma.InspectionWhereInput {
  const term = search?.trim();
  // An empty box is not a filter. Returning `{ OR: [...] }` with an empty
  // string would match every row through `contains`, which is harmless here but
  // costs a needless four-way scan on every keystroke that clears the field.
  if (!term) return {};

  const like = { contains: term, mode: 'insensitive' } as const;
  return {
    OR: [
      // The name is what the table's first column shows, so it is what somebody
      // is reading off the screen when they decide to search for it.
      { propertywareBuilding: { name: like } },
      { propertywareBuilding: { addressLine1: like } },
      { propertywareBuilding: { city: like } },
      // A unit within a building, for the properties that have them. Most rows
      // read "Entire property", but a search for a unit should still find it.
      { propertywareUnit: { name: like } },
    ],
  };
}
