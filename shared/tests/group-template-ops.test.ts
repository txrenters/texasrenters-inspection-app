import { describe, expect, it } from 'vitest';

import {
  applyGroupOps,
  diffGroupOps,
  groupTemplateOpsSchema,
  mapOpStops,
  sameGroups,
  suggestGroupName,
  uniqueGroupName,
  type GroupTemplateOp,
  type LiveGroup,
  type LiveGroups,
} from '../src/contracts/group-template-ops.js';

/**
 * Live editing of a group template (the office, 2026-10-01): two people on one
 * template see each other's changes as they happen, and both keep what they did.
 */

const group = (id: string, stops: number[], extra: Partial<LiveGroup<number>> = {}): LiveGroup<number> => ({
  id,
  name: `Group ${id}`,
  color: '#e6194b',
  target: 9,
  stops,
  ...extra,
});

const stopsOf = (state: LiveGroups<number>) => Object.fromEntries(state.groups.map((entry) => [entry.id, entry.stops]));

describe('the name a group is offered', () => {
  it('keeps a name nobody has', () => {
    expect(uniqueGroupName('North', ['Group 1'])).toBe('North');
  });

  it('moves a taken number on past the highest of its kind', () => {
    const taken = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6', 'Group 7'];
    expect(uniqueGroupName('Group 4', taken)).toBe('Group 8');
    expect(uniqueGroupName('group 4', taken)).toBe('group 8');
    expect(uniqueGroupName('North', ['North'])).toBe('North 2');
    expect(uniqueGroupName('North', ['North', 'North 2'])).toBe('North 3');
  });

  it('follows the pattern the groups already have', () => {
    expect(suggestGroupName([])).toBe('Group 1');
    expect(suggestGroupName(['Group 1', 'Group 2', 'Group 4'])).toBe('Group 5');
    expect(suggestGroupName(['Day 1', 'Day 2', 'The Woodlands', 'Day 7'])).toBe('Day 8');
    expect(suggestGroupName(['The Woodlands', 'Magnolia'])).toBe('Group 1');
    expect(suggestGroupName(['Group 1', 'Group 1'])).toBe('Group 2');
  });

  it('reads a number alone as the number, not a prefix and a digit', () => {
    expect(uniqueGroupName('12', ['12'])).toBe('13');
  });
});

describe('applying a batch', () => {
  const base: LiveGroups<number> = { groups: [group('a', [1, 2, 3]), group('b', [4, 5])] };

  it('moves a stop into a group, out of the one that had it', () => {
    const after = applyGroupOps(base, [{ type: 'stop.add', groupId: 'b', stop: 2 }]);
    expect(stopsOf(after)).toEqual({ a: [1, 3], b: [4, 5, 2] });
  });

  it('does nothing twice: a batch applied again leaves the groups as they are', () => {
    const ops: GroupTemplateOp<number>[] = [
      { type: 'group.create', group: { id: 'c', name: 'Group c', color: '#4363d8', target: 9 } },
      { type: 'stop.add', groupId: 'c', stop: 4 },
      { type: 'stops.order', groupId: 'a', stops: [3, 1, 2] },
    ];
    const once = applyGroupOps(base, ops);
    expect(sameGroups(applyGroupOps(once, ops), once)).toBe(true);
  });

  it('lets an operation about a group somebody deleted do nothing', () => {
    const after = applyGroupOps(base, [
      { type: 'group.delete', groupId: 'b' },
      { type: 'stop.add', groupId: 'b', stop: 1 },
      { type: 'stops.order', groupId: 'b', stops: [5, 4] },
    ]);
    expect(stopsOf(after)).toEqual({ a: [1, 2, 3] });
  });

  it('keeps the stops an order did not name, after the ones it did', () => {
    const after = applyGroupOps(base, [{ type: 'stops.order', groupId: 'a', stops: [3, 99, 1] }]);
    expect(stopsOf(after)).toEqual({ a: [3, 1, 2], b: [4, 5] });
  });

  it('never leaves two groups with one name: the later one moves on', () => {
    const after = applyGroupOps({ groups: [group('a', [], { name: 'Group 5' })] }, [
      { type: 'group.create', group: { id: 'b', name: 'Group 5', color: '#4363d8', target: 9 } },
    ]);
    expect(after.groups.map((entry) => entry.name)).toEqual(['Group 5', 'Group 6']);
  });

  it('never changes the groups it was given', () => {
    const copy = JSON.stringify(base);
    applyGroupOps(base, [{ type: 'stop.remove', stop: 1 }]);
    expect(JSON.stringify(base)).toBe(copy);
  });
});

describe('what one person did, as operations', () => {
  it('is a stop added when a property was clicked into a group', () => {
    const before: LiveGroups<number> = { groups: [group('a', [1, 2])] };
    const after: LiveGroups<number> = { groups: [group('a', [1, 2, 7])] };
    expect(diffGroupOps(before, after)).toEqual([{ type: 'stop.add', groupId: 'a', stop: 7 }]);
  });

  it('lets two groups trade names', () => {
    const before: LiveGroups<number> = { groups: [group('x', [], { name: 'Group 4' }), group('y', [], { name: 'Group 3' })] };
    const after: LiveGroups<number> = { groups: [group('x', [], { name: 'Group 3' }), group('y', [], { name: 'Group 4' })] };
    expect(sameGroups(applyGroupOps(before, diffGroupOps(before, after)), after)).toBe(true);
  });

  it('is an order when a route was optimized, and nothing when nothing changed', () => {
    const before: LiveGroups<number> = { groups: [group('a', [1, 2, 3])] };
    expect(diffGroupOps(before, { groups: [group('a', [3, 1, 2])] })).toEqual([
      { type: 'stops.order', groupId: 'a', stops: [3, 1, 2] },
    ]);
    expect(diffGroupOps(before, before)).toEqual([]);
  });

  /** Any change at all, undo and redo included, comes out as operations that make it. */
  it('always turns the groups before into the groups after', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    const randomGroups = (): LiveGroups<number> => {
      const ids = ['a', 'b', 'c', 'd', 'e'].filter(() => random() < 0.7);
      const groups = ids.map((id) => group(id, [], { color: pick(['#e6194b', '#4363d8']), target: pick([9, 10]) }));
      if (groups.length) for (let stop = 1; stop <= 12; stop += 1) if (random() < 0.8) pick(groups).stops.push(stop);
      groups.sort(() => random() - 0.5);
      return { groups };
    };
    for (let round = 0; round < 400; round += 1) {
      const before = randomGroups();
      const after = randomGroups();
      const ops = diffGroupOps(before, after);
      expect(sameGroups(applyGroupOps(before, ops), after)).toBe(true);
    }
  });
});

describe('two people at once', () => {
  const base: LiveGroups<number> = { groups: [group('a', [1, 2, 3]), group('b', [4])] };

  it('keeps a property one added to a group the other reordered', () => {
    const mine = diffGroupOps(base, { groups: [group('a', [1, 2, 3, 9]), group('b', [4])] });
    const theirs = diffGroupOps(base, { groups: [group('a', [3, 2, 1]), group('b', [4])] });

    // The server applies theirs first, then mine.
    const server = applyGroupOps(applyGroupOps(base, theirs), mine);
    expect(stopsOf(server)).toEqual({ a: [3, 2, 1, 9], b: [4] });
    // This browser had applied mine first, then theirs when it arrived: the same.
    expect(sameGroups(applyGroupOps(applyGroupOps(base, mine), theirs), server)).toBe(true);
  });

  it('keeps both of two groups made at once, under two names', () => {
    const made = (id: string) => diffGroupOps(base, { groups: [...base.groups, group(id, [], { name: 'Group 3' })] });
    const server = applyGroupOps(applyGroupOps(base, made('x')), made('y'));
    // Each goes where its maker put it, third in the list; the later one is renamed.
    expect(server.groups.map((entry) => [entry.id, entry.name])).toEqual([
      ['a', 'Group a'],
      ['b', 'Group b'],
      ['y', 'Group 4'],
      ['x', 'Group 3'],
    ]);
  });
});

describe('between the server and the map', () => {
  it('puts every stop another way, and leaves out what has no counterpart', () => {
    const rows = new Map([
      ['b-1', 2],
      ['b-2', 3],
    ]);
    const mapped = mapOpStops<string, number>(
      [
        { type: 'stop.add', groupId: 'g', stop: 'b-1' },
        { type: 'stop.remove', stop: 'b-gone' },
        { type: 'stops.order', groupId: 'g', stops: ['b-2', 'b-gone', 'b-1'] },
        { type: 'group.delete', groupId: 'h' },
      ],
      (stop) => rows.get(stop),
    );
    expect(mapped).toEqual([
      { type: 'stop.add', groupId: 'g', stop: 2 },
      { type: 'stops.order', groupId: 'g', stops: [3, 2] },
      { type: 'group.delete', groupId: 'h' },
    ]);
  });

  it('accepts only operations it can apply', () => {
    const id = '6f0c1d2e-0000-4000-8000-000000000001';
    expect(groupTemplateOpsSchema.safeParse([{ type: 'stop.add', groupId: id, stop: id }]).success).toBe(true);
    expect(groupTemplateOpsSchema.safeParse([{ type: 'stop.add', groupId: id, stop: 'nope' }]).success).toBe(false);
    expect(
      groupTemplateOpsSchema.safeParse([{ type: 'group.update', groupId: id, color: 'red' }]).success,
    ).toBe(false);
    expect(groupTemplateOpsSchema.safeParse([{ type: 'drop.table' }]).success).toBe(false);
    expect(groupTemplateOpsSchema.safeParse([]).success).toBe(false);
  });
});
