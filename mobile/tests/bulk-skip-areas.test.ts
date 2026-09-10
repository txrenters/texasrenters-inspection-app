import { bulkSkippableAreas } from '../src/utils/submission-gate';

/**
 * Skipping the areas a property does not have, in one action.
 *
 * An occupied visit is offered the standard fifteen-room layout and a real
 * property is rarely all fifteen. Disposing of the rest one at a time is the
 * per-area toll the 2026-09-09 feedback asked us to remove.
 */

type Room = { id: string; name: string; isRequired: boolean; status: string };

const room = (overrides: Partial<Room> & { id: string }): Room => ({
  name: overrides.id,
  isRequired: false,
  status: 'NOT_STARTED',
  ...overrides,
});

const statusOf = (item: Room) => item.status;

describe('choosing the areas a bulk skip may take', () => {
  it('offers only the areas nobody walked', () => {
    const result = bulkSkippableAreas(
      [
        room({ id: 'bedroom-3' }),
        room({ id: 'kitchen', status: 'COMPLETED' }),
        room({ id: 'laundry' }),
      ],
      'OCCUPIED',
      statusOf,
    );
    expect(result.offered).toBe(true);
    expect(result.skippable.map((item) => item.id)).toEqual(['bedroom-3', 'laundry']);
  });

  /**
   * The one that would destroy work. `completionStatus` has never known about
   * photographs, so an area walked with stills reads NOT_STARTED on the column
   * — the derived status is what separates it, and this is the guarantee that
   * the bulk action reads the derived one.
   */
  it('never sweeps up an area that has photographs on it', () => {
    const result = bulkSkippableAreas(
      [room({ id: 'living-room', status: 'IN_PROGRESS' }), room({ id: 'shed' })],
      'OCCUPIED',
      statusOf,
    );
    expect(result.skippable.map((item) => item.id)).toEqual(['shed']);
  });

  it('leaves a skipped area alone rather than skipping it twice', () => {
    const result = bulkSkippableAreas(
      [room({ id: 'attic', status: 'SKIPPED' }), room({ id: 'patio' })],
      'OCCUPIED',
      statusOf,
    );
    expect(result.skippable.map((item) => item.id)).toEqual(['patio']);
  });

  it('names the required areas separately so the prompt can list them', () => {
    const result = bulkSkippableAreas(
      [
        room({ id: 'kitchen', name: 'Kitchen', isRequired: true }),
        room({ id: 'bedroom-3', name: 'Bedroom 3' }),
      ],
      'OCCUPIED',
      statusOf,
    );
    expect(result.skippable).toHaveLength(2);
    expect(result.required.map((item) => item.name)).toEqual(['Kitchen']);
  });

  it('says there is nothing to offer when every area is dealt with', () => {
    const result = bulkSkippableAreas(
      [room({ id: 'kitchen', status: 'COMPLETED' })],
      'OCCUPIED',
      statusOf,
    );
    expect(result.offered).toBe(false);
    expect(result.skippable).toEqual([]);
  });

  it('is offered on a back-to-market visit, which also walks chosen areas', () => {
    expect(bulkSkippableAreas([room({ id: 'yard' })], 'BACK_TO_MARKET', statusOf).offered).toBe(
      true,
    );
  });

  /**
   * A move-in or move-out walks every area by definition, and a move-out is
   * read against its move-in area by area. Waiving ten at once is the opposite
   * of what those visits are for.
   */
  it.each(['MOVE_IN', 'MOVE_OUT'])('is not offered on a %s', (inspectionType) => {
    const result = bulkSkippableAreas(
      [room({ id: 'bedroom-3' }), room({ id: 'laundry' })],
      inspectionType,
      statusOf,
    );
    expect(result.offered).toBe(false);
    expect(result.skippable).toEqual([]);
    expect(result.required).toEqual([]);
  });
});
