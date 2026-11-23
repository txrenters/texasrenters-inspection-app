import type { MyTrucks } from '@texasrenters/shared';

import { myTrucksSchema } from '../src/repositories/api/my-truck-schema';
import { askDraft, askLines, findOnTruck, lowOn, newAskKey, readAskQuantity, scannedOnTruck, truckCardLine, withAdded } from '../src/utils/truck-stock';

/** The truck on the phone, round 2 (2026-11-24). Every item and number invented. */

const item = (code: string, name: string, onHand: number, keepAtLeast: number | null) => ({ itemId: `item-${code}`, code, name, unit: 'each', onHand, keepAtLeast });
const TRUCK = {
  id: 'truck-1',
  name: 'Truck 1',
  mine: true,
  lastCountedOn: '2026-11-02',
  items: [item('BAT-9V', 'Battery, 9 V', 1, 6), item('FLT-16251', 'Filter 16x25x1', 2, 6), item('FLT-20201', 'Filter 20x20x1', 9, null), item('SMK-0010', 'Smoke alarm', 0, 2), item('PST-0004', 'Glue boards', 4, 4)],
  asks: [],
};
const CATALOG = [
  { itemId: 'item-FLT-16251', code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'each' },
  { itemId: 'item-CO-0002', code: 'CO-0002', name: 'CO detector', unit: 'each' },
];

describe('my truck', () => {
  it('says what has run low against what the office keeps on it: below it, not at it', () => {
    expect(lowOn(TRUCK).map((one) => one.code)).toEqual(['BAT-9V', 'FLT-16251', 'SMK-0010']);
    // The smoke alarms ran out and are kept on it: low, though none is on the truck.
    expect(truckCardLine(TRUCK)).toEqual({ held: '4 items on it', low: 3 });
  });

  it('finds by code or name, and tells a code that is no item from one not on the truck', () => {
    expect(findOnTruck(TRUCK.items, 'filter').map((one) => one.code)).toEqual(['FLT-16251', 'FLT-20201']);
    expect(scannedOnTruck(TRUCK, CATALOG, ' flt-16251 ')).toEqual({ item: TRUCK.items[1] });
    expect(scannedOnTruck(TRUCK, CATALOG, 'CO-0002')).toEqual({ said: 'CO-0002 is not on Truck 1.' });
    expect(scannedOnTruck(TRUCK, CATALOG, 'XYZ-999')).toEqual({ said: 'XYZ-999 is not an item code. Check the label, or type it.' });
  });
});

describe('asking for more', () => {
  it('starts with what has run low, each ticked with what brings it back up to what is kept', () => {
    const draft = askDraft(TRUCK);
    expect(draft.map((line) => [line.item.code, line.ticked, line.quantity])).toEqual([
      ['BAT-9V', true, '5'],
      ['FLT-16251', true, '4'],
      ['SMK-0010', true, '2'],
      ['FLT-20201', false, ''],
      ['PST-0004', false, ''],
    ]);
    expect(askLines(draft)).toMatchObject({ lines: [{ itemId: 'item-BAT-9V', quantity: 5 }, { itemId: 'item-FLT-16251', quantity: 4 }, { itemId: 'item-SMK-0010', quantity: 2 }], problem: null });
  });

  it('adds an item not on the truck once, ticked at one, and says what is missing before it is sent', () => {
    const added = withAdded(withAdded(askDraft(TRUCK), CATALOG[1]!), CATALOG[1]!);
    expect(added.filter((line) => line.item.code === 'CO-0002')).toEqual([expect.objectContaining({ ticked: true, quantity: '1', onHand: 0, keepAtLeast: null })]);
    const none = askDraft({ items: [] });
    expect(askLines(none).problem).toBe('Tick what you need, with how many.');
    const bad = askDraft(TRUCK).map((line) => (line.item.code === 'BAT-9V' ? { ...line, quantity: 'six' } : line));
    expect(askLines(bad).problem).toBe('Say how many of Battery, 9 V to ask for.');
    expect([readAskQuantity(' 4 '), readAskQuantity('0'), readAskQuantity('1.5')]).toEqual([4, null, null]);
  });

  it('makes a key of letters, digits and dashes, never twice the same', () => {
    expect(newAskKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(newAskKey(1, () => 0.5)).not.toBe(newAskKey(1, () => 0.25));
  });
});

describe('what the server answers for My truck', () => {
  const reply: MyTrucks = {
    trucks: [{ ...TRUCK, asks: [{ id: 'ask-1', place: { id: 'truck-1', name: 'Truck 1' }, askedBy: { id: 'tech-1', name: 'Kim Example' }, at: '2026-11-24T16:40:00.000Z', note: null, status: 'FILLED', lines: [{ itemId: 'item-BAT-9V', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', quantity: 5 }], filled: { slipNumber: 'TR-0019', at: '2026-11-24T18:00:00.000Z', by: 'Office Coordinator' } }] }],
    slips: [{ id: 'slip-1', number: 'WD-0041', kind: 'WITHDRAWAL', at: '2026-11-24T16:12:00.000Z', place: 'Truck 1', job: { id: 'job-1', address: '1309 Example St' }, lines: [{ code: 'FLT-16251', name: 'Filter 16x25x1', quantity: 2 }], reversed: false }],
    catalog: CATALOG,
  };

  it('is kept whole: every field the screens read is named, and it survives being stored and read back', () => {
    const parsed = myTrucksSchema.parse(reply);
    expect(parsed).toEqual(reply);
    expect(myTrucksSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(reply);
  });
});
