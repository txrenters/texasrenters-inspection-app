/**
 * Coverage bookkeeping for the per-area checklist.
 *
 * Exercised as the pure reducers the store performs, matching the convention in
 * `upload-live-progress.test.ts`: there is no react renderer here, and the
 * rules are what matter, not zustand's plumbing.
 */
type Coverage = Record<string, string[]>;

function toggle(state: Coverage, areaId: string, itemId: string): Coverage {
  const current = state[areaId] ?? [];
  const next = current.includes(itemId)
    ? current.filter((value) => value !== itemId)
    : [...current, itemId];
  return { ...state, [areaId]: next };
}

function markCovered(state: Coverage, areaId: string, itemIds: readonly string[]): Coverage {
  const current = state[areaId] ?? [];
  const next = [...new Set([...current, ...itemIds])];
  if (next.length === current.length) return state;
  return { ...state, [areaId]: next };
}

describe('checklist coverage', () => {
  it('ticks and unticks an item', () => {
    const ticked = toggle({}, 'room-1', 'sink');
    expect(ticked['room-1']).toEqual(['sink']);
    expect(toggle(ticked, 'room-1', 'sink')['room-1']).toEqual([]);
  });

  it('keeps areas independent', () => {
    // The store is one object across every area; ticking in the kitchen must
    // not touch the bathroom's coverage.
    let state = toggle({}, 'room-1', 'sink');
    state = toggle(state, 'room-2', 'toilet');
    expect(state['room-1']).toEqual(['sink']);
    expect(state['room-2']).toEqual(['toilet']);
  });

  it('adds spoken coverage without unticking manual work', () => {
    // The rule that matters once transcript matching drives this: a mention is
    // evidence something was discussed, never evidence it was not.
    const manual = toggle({}, 'room-1', 'floor');
    const after = markCovered(manual, 'room-1', ['sink', 'drain']);
    expect(after['room-1']).toEqual(expect.arrayContaining(['floor', 'sink', 'drain']));
    expect(after['room-1']).toHaveLength(3);
  });

  it('does not duplicate an item already covered', () => {
    const state = markCovered({ 'room-1': ['sink'] }, 'room-1', ['sink']);
    expect(state['room-1']).toEqual(['sink']);
  });

  it('returns the same object when nothing changed', () => {
    // Identity matters: a new object on every transcript line would re-render
    // the camera screen continuously while recording.
    const before: Coverage = { 'room-1': ['sink'] };
    expect(markCovered(before, 'room-1', ['sink'])).toBe(before);
  });

  it('covers an area that has no entry yet', () => {
    expect(markCovered({}, 'room-9', ['walls'])['room-9']).toEqual(['walls']);
  });
});
