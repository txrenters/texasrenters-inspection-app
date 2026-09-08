import { applyAreaOrder } from '../src/areas/area-order';
import type { InspectionRoom } from '../src/domain/models';

/**
 * A technician's own sequence for one inspection.
 *
 * The ordering is applied by rewriting `order` rather than by sorting at the
 * call site, and that is the thing worth pinning. Three separate places sort by
 * `order` — the area list, `pickUpNextArea`, and `nextInspectionRoom`, which is
 * what the camera advances to after a capture. Sorting in one of them would
 * leave somebody looking at their own order while the app kept offering the
 * server's, which is worse than not offering the feature at all.
 */

const room = (id: string, order: number): InspectionRoom =>
  ({ id, name: id, order, isRequired: true }) as InspectionRoom;

const ids = (rooms: readonly InspectionRoom[]) => rooms.map((r) => r.id);

describe('applying a technician’s area order', () => {
  it('leaves the server order alone when nothing has been reordered', () => {
    const rooms = [room('kitchen', 1), room('bath', 2), room('bed', 3)];
    expect(ids(applyAreaOrder(rooms, []))).toEqual(['kitchen', 'bath', 'bed']);
  });

  it('puts the areas in the order the technician chose', () => {
    const rooms = [room('kitchen', 1), room('bath', 2), room('bed', 3)];
    expect(ids(applyAreaOrder(rooms, ['bed', 'kitchen', 'bath']))).toEqual([
      'bed',
      'kitchen',
      'bath',
    ]);
  });

  it('rewrites `order`, so everything that sorts by it follows', () => {
    // The whole design. "Up next" and the post-capture advance both read this
    // field; if it still held the server's numbers they would disagree with the
    // list the technician is looking at.
    const rooms = [room('kitchen', 1), room('bath', 2), room('bed', 3)];
    const applied = applyAreaOrder(rooms, ['bed', 'kitchen', 'bath']);
    expect(applied.map((r) => r.order)).toEqual([0, 1, 2]);
  });

  it('does not mutate the rooms it was given', () => {
    // They come from the react-query cache. Rewriting them in place would
    // change what every other screen reads.
    const rooms = [room('kitchen', 1), room('bath', 2)];
    applyAreaOrder(rooms, ['bath', 'kitchen']);
    expect(rooms.map((r) => r.order)).toEqual([1, 2]);
  });

  it('puts an area added on site at the end, not buried mid-list', () => {
    // A technician can add an area while working, so the set is not fixed. New
    // work is the case that matters in the field — hiding it among rooms
    // already walked is how it gets missed.
    const rooms = [room('kitchen', 1), room('bath', 2), room('garage', 9)];
    expect(ids(applyAreaOrder(rooms, ['bath', 'kitchen']))).toEqual(['bath', 'kitchen', 'garage']);
  });

  it('keeps several new areas in the order the server gave them', () => {
    const rooms = [room('kitchen', 1), room('attic', 8), room('garage', 5)];
    expect(ids(applyAreaOrder(rooms, ['kitchen']))).toEqual(['kitchen', 'garage', 'attic']);
  });

  it('ignores an id for an area that is no longer there', () => {
    // Stored ids outlive the areas they name: one can be removed between
    // sessions, and a stale entry must not leave a hole or drop a real room.
    const rooms = [room('kitchen', 1), room('bath', 2)];
    expect(ids(applyAreaOrder(rooms, ['gone', 'bath', 'kitchen']))).toEqual(['bath', 'kitchen']);
  });

  it('handles an empty inspection', () => {
    expect(applyAreaOrder([], ['kitchen'])).toEqual([]);
  });

  it('gives new areas orders that sort after every chosen one', () => {
    // Not just the array position — the numbers themselves have to keep the
    // relationship, because the consumers re-sort by them.
    const rooms = [room('kitchen', 1), room('garage', 5)];
    const applied = applyAreaOrder(rooms, ['kitchen']);
    const kitchen = applied.find((r) => r.id === 'kitchen')!;
    const garage = applied.find((r) => r.id === 'garage')!;
    expect(kitchen.order).toBeLessThan(garage.order);
  });
});
