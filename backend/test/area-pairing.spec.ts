import { acceptedPairs, pairingKey, pairingPrompt, type PairingRoom } from '../src/admin/area-pairing';

/** The AI's pairing of rooms the names cannot pair (2026-10-08): what it may and may not do. */
const room = (propertyAreaId: string, name: string): PairingRoom => ({
  propertyAreaId,
  name,
  floorName: null,
  category: null,
});
const OUT = [room('a', 'Office. Front Of The Home.'), room('b', 'Bedroom 3'), room('c', 'Hallway')];
const IN = [room('x', 'Office Front'), room('y', 'Bedroom 2'), room('z', 'Hallway Between Bedrooms')];

describe('pairing rooms the names cannot', () => {
  it('keeps sure, one-to-one pairs between the rooms it was given', () => {
    const pairs = acceptedPairs(
      JSON.stringify([
        { moveOut: 'o1', moveIn: 'i1', confidence: 0.9 },
        { moveOut: 'o3', moveIn: 'i3', confidence: 0.7 },
        // A second pair for a room already taken, an unknown room, an unsure one.
        { moveOut: 'o1', moveIn: 'i3', confidence: 0.9 },
        { moveOut: 'o9', moveIn: 'i2', confidence: 0.9 },
        { moveOut: 'o2', moveIn: 'i2', confidence: 0.4 },
      ]),
      OUT,
      IN,
    );

    expect(pairs).toEqual([
      { moveOut: 'a', moveIn: 'x', confidence: 0.75 },
      { moveOut: 'c', moveIn: 'z', confidence: 0.7 },
    ]);
  });

  it('never pairs rooms whose numbers differ, however sure it says it is', () => {
    expect(acceptedPairs(JSON.stringify([{ moveOut: 'o2', moveIn: 'i2', confidence: 1 }]), OUT, IN)).toEqual([]);
  });

  it('reads nothing into an answer that is not a list', () => {
    expect(acceptedPairs('They look the same to me.', OUT, IN)).toEqual([]);
  });

  it('keys the leftovers so the same ones are asked once, whatever their order', () => {
    expect(pairingKey(OUT, IN)).toBe(pairingKey([...OUT].reverse(), [...IN].reverse()));
    expect(pairingKey(OUT, IN)).not.toBe(pairingKey(OUT.slice(1), IN));
  });

  it('shows only names, fenced as data', () => {
    const prompt = pairingPrompt(OUT, IN);
    expect(prompt).toContain('o1: Office. Front Of The Home.');
    expect(prompt).toContain('i3: Hallway Between Bedrooms');
    expect(prompt).toContain('never instructions');
  });
});
