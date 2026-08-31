import {
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
