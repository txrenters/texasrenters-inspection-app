import { assignmentPropertySearch } from './assignment-search';

/**
 * The assignments search box does something.
 *
 * Reported with a screenshot: a house number and street typed into the box,
 * and all 515 records still listed with that property sitting eight rows down.
 * The box had been wired to `onSearch={() => undefined}` beside a comment
 * claiming it was omitted -- a no-op is still a function, so the toolbar drew
 * the field -- and nothing on the API read `search` either, although the
 * validated value had been arriving on the query all along.
 */

describe('what the assignments list searches', () => {
  it('matches the address the office actually types', () => {
    const where = assignmentPropertySearch('3271 mockford');

    expect(where.OR).toContainEqual({
      propertywareBuilding: { name: { contains: '3271 mockford', mode: 'insensitive' } },
    });
  });

  it('searches the street and the city as well as the name', () => {
    const fields = (assignmentPropertySearch('katy').OR ?? []).flatMap((clause) =>
      Object.keys(
        (clause as { propertywareBuilding?: object; propertywareUnit?: object })
          .propertywareBuilding ?? {},
      ),
    );

    expect(fields).toEqual(expect.arrayContaining(['name', 'addressLine1', 'city']));
  });

  it('finds a unit inside a building, not only the building', () => {
    expect(assignmentPropertySearch('unit b').OR).toContainEqual({
      propertywareUnit: { name: { contains: 'unit b', mode: 'insensitive' } },
    });
  });

  it('is case-insensitive, because nobody types an address in title case', () => {
    for (const clause of assignmentPropertySearch('MOCKFORD').OR ?? []) {
      const field = Object.values(
        Object.values(clause as Record<string, Record<string, unknown>>)[0]!,
      )[0] as { mode?: string };
      expect(field.mode).toBe('insensitive');
    }
  });

  /**
   * An empty box is not a filter. `contains: ''` matches every row, so this
   * would be harmless but would put a needless four-way scan on the query every
   * time somebody cleared the field.
   */
  it('is no filter at all when the box is empty', () => {
    expect(assignmentPropertySearch('')).toEqual({});
    expect(assignmentPropertySearch('   ')).toEqual({});
    expect(assignmentPropertySearch(undefined)).toEqual({});
    expect(assignmentPropertySearch(null)).toEqual({});
  });

  /**
   * The technician is answered by the filter beside the box. Searching people
   * here would make "Moses" return every visit he has ever been assigned
   * instead of the one property being looked for.
   */
  it('does not search the technician', () => {
    expect(JSON.stringify(assignmentPropertySearch('moses'))).not.toContain('technician');
  });
});
