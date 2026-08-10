import { checklistSchema } from '../src/repositories/api/repositories';

/**
 * The wire contract for a scored checklist item.
 *
 * These are cached and re-parsed from their own stored output, so the shape has
 * to survive the round trip — and the tri-state has to survive it *as* a
 * tri-state. A null that came back as false would turn "nobody checked" into
 * "found faulty" in the printed report.
 */
function roundTrip(input: unknown) {
  const first = checklistSchema.parse(input);
  const stored = JSON.parse(JSON.stringify(first));
  return { first, second: checklistSchema.parse(stored) };
}

const serverItem = {
  id: 'item-1',
  label: 'Doors and locks',
  keywords: ['door', 'lock'],
  isClean: false,
  isUndamaged: false,
  isWorking: true,
  comment: 'scratches on door need to be painted',
  recordedAt: '2026-08-11T09:00:00.000Z',
};

describe('checklist assessment contract', () => {
  it('produces an identical value on the second parse', () => {
    const { first, second } = roundTrip([serverItem]);
    expect(second).toEqual(first);
  });

  it('keeps a false apart from a null across the trip', () => {
    // The distinction the whole feature rests on: false is "found faulty",
    // null is "nobody assessed it". JSON preserves both, and so must the schema.
    const { second } = roundTrip([
      { ...serverItem, isClean: false, isUndamaged: null, isWorking: true },
    ]);
    expect(second[0]).toMatchObject({ isClean: false, isUndamaged: null, isWorking: true });
  });

  it('reads an item from a backend that cannot score as unassessed', () => {
    // The pre-assessment shape: id, label, keywords and nothing else. It must
    // parse — and must not imply the item was found faulty.
    const { first, second } = roundTrip([
      { id: 'item-1', label: 'Doors and locks', keywords: [] },
    ]);
    expect(first[0]).toMatchObject({
      isClean: null,
      isUndamaged: null,
      isWorking: null,
      comment: null,
      recordedAt: null,
    });
    expect(second).toEqual(first);
  });

  it('rejects a non-boolean axis rather than coercing it', () => {
    // "false" as a string is truthy. Coercing here would record a defect the
    // technician never reported.
    expect(() => checklistSchema.parse([{ ...serverItem, isClean: 'false' }])).toThrow();
  });

  it('keeps an empty keyword list rather than dropping the item', () => {
    const parsed = checklistSchema.parse([{ id: 'a', label: 'Smoke alarms' }]);
    expect(parsed[0]).toMatchObject({ label: 'Smoke alarms', keywords: [] });
  });
});
