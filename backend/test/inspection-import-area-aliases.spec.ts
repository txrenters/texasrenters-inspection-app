import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';

/**
 * Which room of the property a report's area name belongs to.
 *
 * The office names rooms differently between reports -- "Living Room" one
 * visit, "Living Area" the next -- and the importer used to match on the
 * normalised name alone, so every variant added another room to the property.
 * A property walked three times accumulated three sets of rooms, and the
 * comparison was then left choosing between them.
 *
 * The risk in fixing that is the opposite failure: joining a report to a room
 * it does not describe writes its photographs there permanently, with nothing
 * on the page to say so. These pin down where the line sits.
 */

const AREA = 'property-1';
const USER = 'user-1';

function txDouble(areas: Array<{ id: string; name: string; aliases?: string[] }>) {
  const created: Array<Record<string, unknown>> = [];
  const aliases: Array<Record<string, unknown>> = [];
  const tx = {
    propertyArea: {
      findMany: jest.fn().mockResolvedValue(
        areas.map((area) => ({
          id: area.id,
          name: area.name,
          aliases: (area.aliases ?? []).map((alias) => ({ alias })),
        })),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'created-area', name: args.data.name });
      }),
    },
    propertyAreaAlias: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        aliases.push(args.data);
        return Promise.resolve({});
      }),
    },
  };
  return { tx, created, aliases };
}

/** `resolveArea` is private; its behaviour is the entire point of this file. */
function resolve(
  tx: unknown,
  name: string,
): Promise<{ id: string; name: string }> {
  const service = new InspectionImportService({} as never, {} as never, {} as never);
  return (
    service as unknown as {
      resolveArea: (
        tx: unknown,
        propertyId: string,
        name: string,
        createdById: string,
      ) => Promise<{ id: string; name: string }>;
    }
  ).resolveArea(tx, AREA, name, USER);
}

describe('matching a report area to a room of the property', () => {
  it('matches the normalised name', async () => {
    // The report writes "BEDROOM 1" where the console holds "Bedroom 1".
    const { tx, created } = txDouble([{ id: 'bed-1', name: 'Bedroom 1' }]);

    const area = await resolve(tx, 'BEDROOM 1');

    expect(area.id).toBe('bed-1');
    expect(created).toHaveLength(0);
  });

  /**
   * Merging two rooms in the console records the name merged away as an alias.
   * The comparison matcher already honoured those; the importer did not, so a
   * merge held only until the next import recreated the variant room.
   */
  it('matches a name a person already merged away', async () => {
    const { tx, created, aliases } = txDouble([
      { id: 'kitchen', name: 'Kitchen', aliases: ['Kitchen / Breakfast'] },
    ]);

    const area = await resolve(tx, 'kitchen / breakfast');

    expect(area.id).toBe('kitchen');
    expect(created).toHaveLength(0);
    // Already recorded; it must not write it a second time.
    expect(aliases).toHaveLength(0);
  });

  it('joins the same name written differently, and writes down that it did', async () => {
    // Filler words only: one report says "Room", a later one says "Area".
    const { tx, created, aliases } = txDouble([{ id: 'living', name: 'Living Room' }]);

    const area = await resolve(tx, 'Living Area');

    expect(area.id).toBe('living');
    expect(created).toHaveLength(0);
    // Recorded, so the next import matches on the alias rather than repeating
    // the inference, and so a person can see the join was made.
    expect(aliases[0]).toMatchObject({ propertyAreaId: 'living', alias: 'Living Area' });
  });

  it('matches regardless of word order', async () => {
    const { tx, created } = txDouble([{ id: 'master', name: 'Master Bedroom' }]);

    const area = await resolve(tx, 'Bedroom Master');

    expect(area.id).toBe('master');
    expect(created).toHaveLength(0);
  });

  /**
   * Deliberately not joined. "Garage" and "Garage/Carport" are the same room to
   * a reader, and there is no structural rule that says so without also saying
   * "Bedroom Closet" is "Bedroom 2" -- the shape of the two cases is identical.
   * A person merges this one once, and step 2 matches it by alias forever after.
   */
  it('leaves a genuinely different wording for a person to merge', async () => {
    const { tx, created, aliases } = txDouble([{ id: 'garage', name: 'Garage/Carport' }]);

    const area = await resolve(tx, 'Garage');

    expect(area.id).toBe('created-area');
    expect(created[0]).toMatchObject({ name: 'Garage' });
    expect(aliases).toHaveLength(0);
  });

  /**
   * The case that prompted all of this, and the one it deliberately does not
   * solve. "Dining Area" is one room where the property knows two, and nothing
   * in the names says which -- so it adds a room and waits for a person, rather
   * than writing a move-out's photographs into whichever happened to sort first.
   */
  it('refuses to choose between two rooms that fit equally', async () => {
    const { tx, created, aliases } = txDouble([
      { id: 'dining-1', name: 'Dining 1' },
      { id: 'dining-2', name: 'Dining 2' },
    ]);

    const area = await resolve(tx, 'Dining Area');

    expect(area.id).toBe('created-area');
    expect(created[0]).toMatchObject({ name: 'Dining Area' });
    // No alias, because no join was made. Recording one would assert a
    // relationship nobody established.
    expect(aliases).toHaveLength(0);
  });

  it('does not join rooms that merely share a word', async () => {
    // The case that killed containment matching. Once the numeral is dropped,
    // "Bedroom 2" reduces to "bedroom", which *is* contained in "Bedroom
    // Closet" -- so a subset rule would have given a closet a bedroom's
    // photographs. Equality does not.
    const { tx, created } = txDouble([{ id: 'bed-2', name: 'Bedroom 2' }]);

    const area = await resolve(tx, 'Bedroom Closet');

    expect(area.id).toBe('created-area');
    expect(created[0]).toMatchObject({ name: 'Bedroom Closet' });
  });

  it('adds a room the property has never heard of', async () => {
    // Never dropped: the report is evidence the room was walked.
    const { tx, created } = txDouble([{ id: 'kitchen', name: 'Kitchen' }]);

    const area = await resolve(tx, 'Wine Cellar');

    expect(area.id).toBe('created-area');
    expect(created[0]).toMatchObject({ name: 'Wine Cellar' });
  });
});
