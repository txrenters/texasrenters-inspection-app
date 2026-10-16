import { linkedJobberProperty } from '../src/integrations/jobber/jobber.booking';

/**
 * Booking against the Jobber property at a place's own address when no link
 * names one (2026-10-16). Addresses, ZIPs and ids invented.
 */

type Row = Record<string, unknown>;

const HOUSE = '100 Example St';
const POSTAL = '77001-1234';

/** One Jobber property, as the newest visit at it reports it. */
const seenProperty = (jobberPropertyId: string, street1: string, overrides: Row = {}): Row => ({
  jobberPropertyId,
  street1,
  street2: '',
  city: 'Houston',
  province: 'TX',
  postalCode: '77001',
  lastUsedAt: '2026-09-14T05:00:00Z',
  linkStatus: null,
  linkedBuildingId: null,
  linkedAddressLine1: null,
  linkedPostalCode: null,
  ...overrides,
});

/**
 * The three reads, told apart by their SQL: the place's own links, the place's
 * address, and the Jobber properties the sync has seen on visits.
 */
function client({
  links = [],
  address = { addressLine1: HOUSE, postalCode: POSTAL, unitAddressLine1: null, unitPostalCode: null },
  seen = [],
}: { links?: Row[]; address?: Row | null; seen?: Row[] } = {}) {
  const $queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (sql.includes('unitAddressLine1')) return Promise.resolve(address ? [address] : []);
    if (sql.includes('DISTINCT ON')) return Promise.resolve(seen);
    return Promise.resolve(links);
  });
  return { $queryRaw } as unknown as Parameters<typeof linkedJobberProperty>[0] & { $queryRaw: jest.Mock };
}

const ORG = 'org-1';
const BUILDING = 'building-1';
const place = (unitId: string | null = null) => ({ buildingId: BUILDING, unitId });

describe('booking at the Jobber property at the address, when no link names one', () => {
  it('leaves a place with a link of its own to that link, and reads nothing more', async () => {
    const db = client({
      links: [{ jobberPropertyId: 'linked', jobberAddress: HOUSE, propertywareUnitId: null, lastUsedAt: null }],
      seen: [seenProperty('other', HOUSE)],
    });

    await expect(linkedJobberProperty(db, ORG, place())).resolves.toMatchObject({
      status: 'LINKED',
      jobberPropertyId: 'linked',
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('books a house Propertyware holds twice at the property linked to its other record', async () => {
    const db = client({
      seen: [
        seenProperty('the-house', `${HOUSE}`, {
          linkStatus: 'LINKED',
          linkedBuildingId: 'building-2',
          linkedAddressLine1: HOUSE,
          linkedPostalCode: POSTAL,
        }),
      ],
    });

    await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({
      status: 'LINKED',
      jobberPropertyId: 'the-house',
      address: '100 Example St • Houston, TX • 77001',
    });
  });

  it('books a property the sync saw only on finished visits, with the street type written out', async () => {
    const db = client({ seen: [seenProperty('finished-only', '100 Example Street')] });
    await expect(linkedJobberProperty(db, ORG, place())).resolves.toMatchObject({
      status: 'LINKED',
      jobberPropertyId: 'finished-only',
    });
  });

  describe('a unit with no link of its own', () => {
    const backhouse = (unitAddressLine1: string | null) => ({
      addressLine1: HOUSE,
      postalCode: POSTAL,
      unitAddressLine1,
      unitPostalCode: POSTAL,
    });
    const atTheHouse = seenProperty('the-house', HOUSE, {
      linkStatus: 'LINKED',
      linkedBuildingId: BUILDING,
      linkedAddressLine1: HOUSE,
      linkedPostalCode: POSTAL,
    });

    it('books at the property at its own address first', async () => {
      const db = client({
        address: backhouse('100 1/2 Example St'),
        seen: [atTheHouse, seenProperty('the-half', '100 1/2 Example St')],
      });
      await expect(linkedJobberProperty(db, ORG, place('unit-half'))).resolves.toMatchObject({
        jobberPropertyId: 'the-half',
      });
    });

    it('and otherwise at the house, where the office books it', async () => {
      const db = client({ address: backhouse('100 1/4 Example St'), seen: [atTheHouse] });
      await expect(linkedJobberProperty(db, ORG, place('unit-quarter'))).resolves.toMatchObject({
        jobberPropertyId: 'the-house',
      });
    });

    it('but never at another unit’s own property', async () => {
      const db = client({
        address: backhouse(null),
        seen: [seenProperty('apartment-2', HOUSE, { street2: 'Apt 2' })],
      });
      await expect(linkedJobberProperty(db, ORG, place('unit-3'))).resolves.toEqual({ status: 'NOT_LINKED' });
    });
  });

  describe('still refuses', () => {
    it('a property somebody linked to a house at another address', async () => {
      const db = client({
        seen: [
          seenProperty('mistyped', HOUSE, {
            linkStatus: 'LINKED',
            linkedBuildingId: 'building-104',
            linkedAddressLine1: '104 Example St',
            linkedPostalCode: POSTAL,
          }),
        ],
      });
      await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({ status: 'NOT_LINKED' });
    });

    it('a property set aside, or marked "(Do not use)"', async () => {
      const db = client({
        seen: [
          seenProperty('set-aside', HOUSE, { linkStatus: 'IGNORED' }),
          seenProperty('retired', `${HOUSE} (Do not use)`),
        ],
      });
      await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({ status: 'NOT_LINKED' });
    });

    it('a property at another address, or another ZIP', async () => {
      const db = client({
        seen: [seenProperty('next-door', '102 Example St'), seenProperty('other-town', HOUSE, { postalCode: '77002' })],
      });
      await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({ status: 'NOT_LINKED' });
    });

    it('two properties at the address last used on the same day', async () => {
      const db = client({ seen: [seenProperty('one', HOUSE), seenProperty('two', '100 Example Street')] });
      await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({ status: 'NOT_LINKED' });
    });

    it('a place with no address to match on', async () => {
      const db = client({ address: null, seen: [seenProperty('the-house', HOUSE)] });
      await expect(linkedJobberProperty(db, ORG, place())).resolves.toEqual({ status: 'NOT_LINKED' });
    });
  });

  it('takes the one the office used most recently when Jobber holds the house twice', async () => {
    const db = client({
      seen: [
        seenProperty('older', HOUSE, { lastUsedAt: '2026-06-01T05:00:00Z' }),
        seenProperty('newer', '100 Example Street', { lastUsedAt: '2026-09-01T05:00:00Z' }),
      ],
    });
    await expect(linkedJobberProperty(db, ORG, place())).resolves.toMatchObject({ jobberPropertyId: 'newer' });
  });
});
