import {
  addressKeyCandidates,
  buildAddressIndex,
  matchBuilding,
  normalizeAddressKey,
  normalizePostalCode,
} from '../src/integrations/jobber/jobber.address';

describe('Jobber address normalization', () => {
  it('collapses the written forms of a street suffix', () => {
    expect(normalizeAddressKey('1200 Oak Street', '75001')).toBe(
      normalizeAddressKey('1200 Oak St', '75001'),
    );
    expect(normalizeAddressKey('44 North Elm Boulevard', '75002')).toBe(
      normalizeAddressKey('44 N Elm Blvd', '75002'),
    );
  });

  it('ignores punctuation and casing, which the two systems disagree about', () => {
    expect(normalizeAddressKey('1200 OAK ST.', '75001')).toBe(
      normalizeAddressKey('1200 oak st', '75001'),
    );
  });

  it('matches on the five digits both systems agree on, not ZIP+4', () => {
    expect(normalizePostalCode('75001-4321')).toBe('75001');
    expect(normalizeAddressKey('1200 Oak St', '75001-4321')).toBe(
      normalizeAddressKey('1200 Oak St', '75001'),
    );
  });

  it('produces no key at all when there is not enough to match on', () => {
    // Must be empty rather than a partial key: a key built from a missing
    // street would make every address-less property match every other one.
    expect(normalizeAddressKey('', '75001')).toBe('');
    expect(normalizeAddressKey('1200 Oak St', null)).toBe('');
    expect(normalizeAddressKey(null, null)).toBe('');
  });

  it('keeps genuinely different streets apart', () => {
    expect(normalizeAddressKey('1200 Oak St', '75001')).not.toBe(
      normalizeAddressKey('1200 Oak Ave', '75001'),
    );
    expect(normalizeAddressKey('1200 Oak St', '75001')).not.toBe(
      normalizeAddressKey('1200 Oak St', '75002'),
    );
  });
});

describe('Jobber building matching', () => {
  const buildings = [
    { id: 'building-1', addressLine1: '1200 Oak Street', postalCode: '75001' },
    { id: 'building-2', addressLine1: '44 Elm Ave', postalCode: '75002' },
    // A duplex entered twice — the case that must never be auto-resolved.
    { id: 'duplex-a', addressLine1: '9 Pine Ln', postalCode: '75003' },
    { id: 'duplex-b', addressLine1: '9 Pine Lane', postalCode: '75003' },
    // No postal code, so it can never be matched on address alone.
    { id: 'building-3', addressLine1: '77 Cedar Ct', postalCode: null },
  ];
  const index = buildAddressIndex(buildings);

  it('resolves exactly one candidate', () => {
    expect(matchBuilding(index, normalizeAddressKey('1200 Oak St', '75001'))).toEqual({
      outcome: 'MATCHED',
      buildingId: 'building-1',
    });
  });

  it('refuses to pick between two buildings at the same address', () => {
    const match = matchBuilding(index, normalizeAddressKey('9 Pine Ln', '75003'));
    expect(match.outcome).toBe('AMBIGUOUS');
    expect(match).toMatchObject({ buildingIds: expect.arrayContaining(['duplex-a', 'duplex-b']) });
  });

  it('reports no match rather than a near one', () => {
    expect(matchBuilding(index, normalizeAddressKey('1200 Oak St', '75009'))).toEqual({
      outcome: 'NONE',
    });
  });

  it('never matches on an empty key, however many keyless buildings exist', () => {
    expect(matchBuilding(index, '')).toEqual({ outcome: 'NONE' });
    expect(matchBuilding(index, normalizeAddressKey('77 Cedar Ct', null))).toEqual({
      outcome: 'NONE',
    });
  });

  it('leaves buildings with no usable address out of the index entirely', () => {
    expect([...index.values()].flat()).not.toContain('building-3');
  });
});

/**
 * Every case below is a real pair from the live queue, which held 24 unmatched
 * properties against a Propertyware set that contained almost all of them. The
 * addresses were never the problem; the key was.
 */
describe('what the two systems write differently', () => {
  const index = (rows: Array<[string, string]>) =>
    buildAddressIndex(rows.map(([addressLine1, postalCode], i) => ({ id: `b${i}`, addressLine1, postalCode })));

  it('ignores an office note written into the address', () => {
    // The office retires a Jobber property by renaming it, so five addresses
    // carried "(Do not use)" and matched nothing. A parenthetical never
    // distinguishes two real addresses, so dropping it cannot merge two places.
    const found = matchBuilding(
      index([['3002 Thicket Path Way', '77493-4427']]),
      addressKeyCandidates('3002 Thicket Path Way (Do not use)', null, '77493'),
    );
    expect(found).toEqual({ outcome: 'MATCHED', buildingId: 'b0' });
  });

  it('ignores a city and state written into the street line', () => {
    // Propertyware carries the whole address in line 1 for a whole market:
    // "1508B Creekside Ln, Nacogdoches, Texas 75964". Eleven properties were
    // unmatchable for this reason alone.
    const found = matchBuilding(
      index([['1508B Creekside Ln, Nacogdoches, Texas 75964', '75964-2648']]),
      addressKeyCandidates('1508B Creekside Ln', null, '75964-2648'),
    );
    expect(found).toEqual({ outcome: 'MATCHED', buildingId: 'b0' });
  });

  it('folds a unit Jobber puts on its own line into the street line', () => {
    // Jobber: "5200 Weslayan Street" + "unit a201".
    // Propertyware: "5200 Weslayan Street Unit #A201". Neither is wrong.
    const found = matchBuilding(
      index([['5200 Weslayan Street Unit #A201', '77005-1203']]),
      addressKeyCandidates('5200 Weslayan Street', 'unit a201', '77005'),
    );
    expect(found).toEqual({ outcome: 'MATCHED', buildingId: 'b0' });
  });

  it('prefers the unit over the building when both are on file', () => {
    // Order is the whole point: falling to the broader key first would file a
    // specific home's visits against the building.
    const found = matchBuilding(
      index([
        ['1311 Antoine Dr', '77055'],
        ['1311 Antoine Dr Apt 258', '77055'],
      ]),
      addressKeyCandidates('1311 Antoine Drive', 'apt 258', '77055'),
    );
    expect(found).toEqual({ outcome: 'MATCHED', buildingId: 'b1' });
  });

  it('still matches the building when only the building is on file', () => {
    const found = matchBuilding(
      index([['1311 Antoine Dr', '77055']]),
      addressKeyCandidates('1311 Antoine Drive', 'apt 258', '77055'),
    );
    expect(found).toEqual({ outcome: 'MATCHED', buildingId: 'b0' });
  });

  it('reports an ambiguous unit rather than falling back to the building', () => {
    // Answering a question nobody asked. Two homes sharing a unit address is a
    // real conflict, and linking the building instead hides it behind a match
    // that looks clean.
    const found = matchBuilding(
      index([
        ['5200 Weslayan St', '77005'],
        ['5200 Weslayan Street Unit #A201', '77005'],
        ['5200 Weslayan St Unit A201', '77005'],
      ]),
      addressKeyCandidates('5200 Weslayan Street', 'unit a201', '77005'),
    );
    expect(found.outcome).toBe('AMBIGUOUS');
  });

  it('refuses a truncated street name rather than guessing at it', () => {
    // "12618 Alta Vis" against "12618 Alta Vista", same ZIP. Almost certainly
    // the same place — and still not something to decide here. A wrong link
    // sends a technician to the wrong door and files photos against somebody
    // else's property, so it goes to a person.
    const found = matchBuilding(
      index([['12618 Alta Vista', '77354-6992']]),
      addressKeyCandidates('12618 Alta Vis', null, '77354-6992'),
    );
    expect(found).toEqual({ outcome: 'NONE' });
  });

  it('refuses a missing street suffix rather than guessing at it', () => {
    // "2455 Morgan Ridge" against "2455 Morgan Ridge Ln". Same reasoning: the
    // suffix is the part that distinguishes a Lane from a Drive.
    const found = matchBuilding(
      index([['2455 Morgan Ridge Ln', '77386-3316']]),
      addressKeyCandidates('2455 Morgan Ridge', null, '77386'),
    );
    expect(found).toEqual({ outcome: 'NONE' });
  });

  it('produces no key at all when there is nothing to match on', () => {
    // Not an empty key: an empty key would match every address-less property
    // to every other one.
    expect(addressKeyCandidates('(Do not use)', null, '77493')).toEqual([]);
    expect(addressKeyCandidates('1200 Oak St', null, '')).toEqual([]);
  });
});
