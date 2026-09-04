import {
  buildAddressIndex,
  buildLooseAddressIndex,
  looseAddressKey,
  matchBuildingWithFallback,
  normalizeAddressKey,
} from '../src/integrations/jobber/jobber.address';

/**
 * Two systems disagreeing about whether the street type was written.
 *
 * Jobber's property record says `2455 Morgan Ridge`. Propertyware says
 * `2455 Morgan Ridge Ln`. Same house number, same street name, same ZIP+4 —
 * one system simply never recorded the `Ln`, and the address key could not
 * bridge it, so a real property sat in the mapping queue waiting for somebody
 * to click Resolve on an answer that was never in doubt.
 *
 * Half the live queue was this. The other half is not fixable here and must
 * stay unfixed: see the last block.
 */

const buildings = [
  { id: 'morgan', addressLine1: '2455 Morgan Ridge Ln', postalCode: '77386-3316' },
  { id: 'bayou', addressLine1: '2507 Shady Bayou Ln', postalCode: '77373-9122' },
  { id: 'main', addressLine1: '5009 N Main St', postalCode: '77009-3620' },
];

const strict = buildAddressIndex(buildings);
const loose = buildLooseAddressIndex(buildings);

const match = (line1: string, postal: string, line2: string | null = null) =>
  matchBuildingWithFallback(
    strict,
    loose,
    [normalizeAddressKey(line1, postal)].concat(line2 ? [normalizeAddressKey(line2, postal)] : []),
    looseAddressKey(line1, postal),
  );

describe('an address written without its street type', () => {
  it('matches the building that has one', () => {
    // The row from the live queue.
    expect(match('2455 Morgan Ridge', '77386-3316')).toEqual({
      outcome: 'MATCHED',
      buildingId: 'morgan',
    });
    expect(match('2507 Shady Bayou', '77373-9122')).toEqual({
      outcome: 'MATCHED',
      buildingId: 'bayou',
    });
  });

  it('matches in the other direction too', () => {
    // Jobber having the type and Propertyware lacking it is the same fault
    // wearing a different hat, and the loose key is built from both sides.
    const withoutType = [{ id: 'oak', addressLine1: '900 Oak', postalCode: '77001' }];
    expect(
      matchBuildingWithFallback(
        buildAddressIndex(withoutType),
        buildLooseAddressIndex(withoutType),
        [normalizeAddressKey('900 Oak St', '77001')],
        looseAddressKey('900 Oak St', '77001'),
      ),
    ).toEqual({ outcome: 'MATCHED', buildingId: 'oak' });
  });

  it('still prefers the exact address when there is one', () => {
    // The strict tier decides whenever it can. A loose key can only ever gather
    // more candidates, so it must never get to overrule a precise answer.
    expect(match('5009 N Main St', '77009-3620')).toEqual({
      outcome: 'MATCHED',
      buildingId: 'main',
    });
  });
});

describe('what the looser key must never do', () => {
  it('refuses when dropping the type makes two buildings identical', () => {
    // `123 Oak St` and `123 Oak Ave` are different streets. Collapsing them is
    // exactly the information the type carries, so the answer has to be "ask a
    // person", not a coin toss.
    const twins = [
      { id: 'st', addressLine1: '123 Oak St', postalCode: '77002' },
      { id: 'ave', addressLine1: '123 Oak Ave', postalCode: '77002' },
    ];
    const result = matchBuildingWithFallback(
      buildAddressIndex(twins),
      buildLooseAddressIndex(twins),
      [normalizeAddressKey('123 Oak', '77002')],
      looseAddressKey('123 Oak', '77002'),
    );
    expect(result.outcome).toBe('AMBIGUOUS');
  });

  it('does not drop a word that is part of the street name', () => {
    // The trap this feature could have walked into. `Ridge` is a real USPS
    // street type, and had it been droppable, `morgan ridge ln` would lose
    // `ln` while `morgan ridge` lost `ridge` — and the two would stop matching
    // each other, breaking the very row this was written for.
    expect(looseAddressKey('2455 Morgan Ridge Ln', '77386')).toBe('2455 morgan ridge|77386');
    expect(looseAddressKey('2455 Morgan Ridge', '77386')).toBe('2455 morgan ridge|77386');
  });

  it('never reduces a street to its house number', () => {
    // `900 Park` is a street, not a number. Dropping `park` would leave a key
    // that matches every other house numbered 900 in the ZIP.
    expect(looseAddressKey('900 St', '77003')).toBe('900 st|77003');
  });

  it('does not cross a ZIP boundary', () => {
    // The ZIP is doing most of the work here. Same street, one town over, is a
    // different place and must stay unmatched.
    expect(match('2455 Morgan Ridge', '77002')).toEqual({ outcome: 'NONE' });
  });

  it('leaves a genuinely absent property unmatched', () => {
    // `1860 White Oak Dr Apt 324` was in the live queue and is *correctly*
    // there: no such building exists on our side at all. Loosening the key must
    // not invent one.
    expect(match('1860 White Oak Dr Apt 324', '77009-7557')).toEqual({ outcome: 'NONE' });
  });

  it('does not retry an ambiguous strict answer more loosely', () => {
    // A looser key can only gather more candidates, so falling through could
    // not resolve the conflict — it would only hide it behind a broader
    // question than the one that failed.
    const duplex = [
      { id: 'a', addressLine1: '77 Elm St', postalCode: '77004' },
      { id: 'b', addressLine1: '77 Elm St', postalCode: '77004' },
    ];
    const result = matchBuildingWithFallback(
      buildAddressIndex(duplex),
      buildLooseAddressIndex(duplex),
      [normalizeAddressKey('77 Elm St', '77004')],
      looseAddressKey('77 Elm St', '77004'),
    );
    expect(result).toEqual({ outcome: 'AMBIGUOUS', buildingIds: ['a', 'b'] });
  });
});
