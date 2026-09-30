/**
 * Live editing of a group template (the office, 2026-10-01): "if someone logged
 * in and they are working also for the same template I want to see the changes
 * real time".
 *
 * Every change to a template is a small operation -- this property into that
 * group, this group renamed -- rather than the whole template. The server
 * applies each batch in turn and passes it on to everyone else with the
 * template open, and every browser applies the same batches with the same
 * function (`applyGroupOps`), so all of them end up where the server is.
 *
 * Operations say what the person meant, not where things were: "put property X
 * in group G", never "insert at row 7". Two people working on the template at
 * once therefore both keep what they did -- one adding a property to a group
 * while the other reorders it ends with the property in the reordered group --
 * and a batch applied twice changes nothing the second time.
 *
 * Generic over what a stop is: a building id on the server and in the wire
 * format, a row number in the browser's map.
 */

import { z } from 'zod';

/** A group as live editing holds it: its fields and its stops in driving order. */
export interface LiveGroup<K> {
  id: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  target: number;
  stops: K[];
}

export interface LiveGroups<K> {
  groups: LiveGroup<K>[];
}

export type GroupTemplateOp<K = string> =
  /** The template's own name or minutes per property; the groups ignore it. */
  | { type: 'template.update'; name?: string; minutesPerProperty?: number }
  /** A new, empty group, at `index` in the list or at the end. Nothing when the id already exists. */
  | { type: 'group.create'; group: { id: string; name: string; color: string; target: number }; index?: number }
  | { type: 'group.update'; groupId: string; name?: string; color?: string; target?: number }
  /** The group goes; its stops are in no group. */
  | { type: 'group.delete'; groupId: string }
  /** The groups named first, in this order; any not named -- made meanwhile by somebody else -- after them. */
  | { type: 'groups.order'; groupIds: string[] }
  /** The stop to the end of the group, out of whichever group had it. Nothing when the group is gone. */
  | { type: 'stop.add'; groupId: string; stop: K }
  | { type: 'stop.remove'; stop: K }
  /** The group's stops named first, in this order; any not named -- added meanwhile -- after them. */
  | { type: 'stops.order'; groupId: string; stops: K[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = z.string().regex(UUID);
const name = z.string().trim().min(1).max(80);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const target = z.number().int().min(1).max(24);

/** One operation as the server accepts it, stops as building ids. */
export const groupTemplateOpSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('template.update'),
    name: name.optional(),
    minutesPerProperty: z.number().int().min(5).max(240).optional(),
  }),
  z.object({
    type: z.literal('group.create'),
    group: z.object({ id, name, color, target }),
    index: z.number().int().min(0).max(1000).optional(),
  }),
  z.object({
    type: z.literal('group.update'),
    groupId: id,
    name: name.optional(),
    color: color.optional(),
    target: target.optional(),
  }),
  z.object({ type: z.literal('group.delete'), groupId: id }),
  z.object({ type: z.literal('groups.order'), groupIds: z.array(id).max(1000) }),
  z.object({ type: z.literal('stop.add'), groupId: id, stop: id }),
  z.object({ type: z.literal('stop.remove'), stop: id }),
  z.object({ type: z.literal('stops.order'), groupId: id, stops: z.array(id).max(100) }),
]);

/** A batch as the server accepts it: small enough to apply in one short transaction. */
export const groupTemplateOpsSchema = z.array(groupTemplateOpSchema).min(1).max(500);

/** A batch the server applied, as everyone with the template open is told it. */
export interface GroupTemplateOpsEvent {
  templateId: string;
  /** The template's revision once this batch was applied: batches arrive one revision apart. */
  revision: number;
  /** The sender's own id for the batch, so it knows its own when it comes back. */
  batchId: string;
  ops: GroupTemplateOp<string>[];
  by: { userId: string; name: string };
}

/** Somebody with the template open, and the group they are building, if any. */
export interface GroupTemplateEditor {
  userId: string;
  name: string;
  groupId: string | null;
}

const key = (value: string) => value.trim().toLowerCase();

/** "Group 12" as "Group" and 12; null for a name that does not end in a number. */
function numbered(value: string): { prefix: string; number: number } | null {
  // The prefix ends in something other than a digit, so "12" is 12 and not "1" and 2.
  const match = /^(.*?[^\d\s])?\s*(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { prefix: match[1] ?? '', number: Number(match[2]) };
}

/**
 * `wanted`, or -- when another group already has it -- the next number after
 * the highest of its kind: "Group 4" taken beside Group 1 to 7 is "Group 8",
 * and a name with no number gets one, "North" becoming "North 2".
 *
 * The same every time for the same names, so a browser and the server settle a
 * clash between two people who made "Group 5" at once the same way.
 */
export function uniqueGroupName(wanted: string, taken: readonly string[]): string {
  const trimmed = wanted.trim();
  const names = new Set(taken.map(key));
  if (!names.has(key(trimmed))) return trimmed;
  const parts = numbered(trimmed);
  const prefix = parts ? parts.prefix : trimmed;
  let number = 1;
  for (const other of taken) {
    const of = numbered(other);
    if (of && key(of.prefix) === key(prefix)) number = Math.max(number, of.number);
  }
  const join = (value: number) => (prefix ? `${prefix} ${value}` : String(value));
  do number += 1;
  while (names.has(key(join(number))));
  return join(number);
}

/**
 * The name a new group is offered: the pattern the groups already follow, one
 * on. "Day 1" to "Day 7" offers "Day 8"; "Group 1", "Group 2" and "Group 4"
 * offer "Group 5" rather than reusing a number somebody may still be calling
 * a group by. With nothing numbered yet, "Group" and the next number free.
 */
export function suggestGroupName(taken: readonly string[]): string {
  const kinds = new Map<string, { prefix: string; count: number; last: number }>();
  taken.forEach((value, index) => {
    const parts = numbered(value);
    if (!parts || !parts.prefix) return;
    const kind = kinds.get(key(parts.prefix)) ?? { prefix: parts.prefix, count: 0, last: -1 };
    kinds.set(key(parts.prefix), { prefix: parts.prefix, count: kind.count + 1, last: index });
  });
  // The kind most groups follow; of two as common, the one used last.
  const chosen = [...kinds.values()].sort((one, other) => other.count - one.count || other.last - one.last)[0];
  const prefix = chosen?.prefix ?? 'Group';
  let highest = 0;
  for (const other of taken) {
    const parts = numbered(other);
    if (parts && key(parts.prefix) === key(prefix)) highest = Math.max(highest, parts.number);
  }
  return uniqueGroupName(`${prefix} ${highest + 1}`, taken);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The groups with a batch applied, in order. Pure: `state` is not changed.
 *
 * Every operation that no longer fits -- a group somebody else deleted, a stop
 * already where it is being put -- does nothing rather than failing, so a
 * batch made against an older copy still applies.
 */
export function applyGroupOps<K>(state: LiveGroups<K>, ops: readonly GroupTemplateOp<K>[]): LiveGroups<K> {
  let groups = state.groups.map((group) => ({ ...group, stops: [...group.stops] }));
  const find = (groupId: string) => groups.find((group) => group.id === groupId);
  const namesBesides = (groupId: string) => groups.filter((group) => group.id !== groupId).map((group) => group.name);

  for (const op of ops) {
    switch (op.type) {
      case 'template.update':
        break;
      case 'group.create': {
        if (find(op.group.id)) break;
        const made: LiveGroup<K> = {
          ...op.group,
          name: uniqueGroupName(op.group.name, groups.map((group) => group.name)),
          stops: [],
        };
        groups.splice(op.index === undefined ? groups.length : clamp(op.index, 0, groups.length), 0, made);
        break;
      }
      case 'group.update': {
        const group = find(op.groupId);
        if (!group) break;
        if (op.name !== undefined) group.name = uniqueGroupName(op.name, namesBesides(group.id));
        if (op.color !== undefined) group.color = op.color;
        if (op.target !== undefined) group.target = op.target;
        break;
      }
      case 'group.delete':
        groups = groups.filter((group) => group.id !== op.groupId);
        break;
      case 'groups.order': {
        const named = [...new Set(op.groupIds)].flatMap((groupId) => find(groupId) ?? []);
        const listed = new Set(named.map((group) => group.id));
        groups = [...named, ...groups.filter((group) => !listed.has(group.id))];
        break;
      }
      case 'stop.add': {
        const group = find(op.groupId);
        if (!group || group.stops.includes(op.stop)) break;
        for (const other of groups) other.stops = other.stops.filter((stop) => stop !== op.stop);
        group.stops.push(op.stop);
        break;
      }
      case 'stop.remove':
        for (const group of groups) group.stops = group.stops.filter((stop) => stop !== op.stop);
        break;
      case 'stops.order': {
        const group = find(op.groupId);
        if (!group) break;
        const members = new Set(group.stops);
        const named = [...new Set(op.stops)].filter((stop) => members.has(stop));
        const listed = new Set(named);
        group.stops = [...named, ...group.stops.filter((stop) => !listed.has(stop))];
        break;
      }
    }
  }
  return { groups };
}

const same = <T>(one: readonly T[], other: readonly T[]) =>
  one.length === other.length && one.every((value, index) => value === other[index]);

/**
 * The operations that turn `before` into `after`: what one person just did,
 * worked out from their groups before and after it, whatever it was -- a
 * click, an undo, an optimized route.
 *
 * As small as it can be, so it mixes with what somebody else did at the same
 * time: a property added is `stop.add`, not the whole group again. Orders are
 * sent only where the adds alone would not leave them right.
 */
export function diffGroupOps<K>(before: LiveGroups<K>, after: LiveGroups<K>): GroupTemplateOp<K>[] {
  const ops: GroupTemplateOp<K>[] = [];
  const was = new Map(before.groups.map((group) => [group.id, group]));
  const now = new Map(after.groups.map((group) => [group.id, group]));

  for (const group of before.groups) if (!now.has(group.id)) ops.push({ type: 'group.delete', groupId: group.id });
  after.groups.forEach((group, index) => {
    if (!was.has(group.id))
      ops.push({
        type: 'group.create',
        group: { id: group.id, name: group.name, color: group.color, target: group.target },
        index,
      });
  });
  for (const group of after.groups) {
    const old = was.get(group.id);
    if (!old) continue;
    const changes: { name?: string; color?: string; target?: number } = {};
    if (old.name !== group.name) changes.name = group.name;
    if (old.color !== group.color) changes.color = group.color;
    if (old.target !== group.target) changes.target = group.target;
    if (Object.keys(changes).length) ops.push({ type: 'group.update', groupId: group.id, ...changes });
  }
  // Two groups trading names: the first rename finds the name still taken and
  // moves on to the next number, so the names are set again until they hold.
  for (let round = 0; round < 3; round += 1) {
    const reached = applyGroupOps(before, ops);
    const wrong = after.groups.filter((group) => {
      const got = reached.groups.find((entry) => entry.id === group.id);
      return got !== undefined && got.name !== group.name;
    });
    if (!wrong.length) break;
    for (const group of wrong) ops.push({ type: 'group.update', groupId: group.id, name: group.name });
  }

  const inBefore = new Map<K, string>();
  for (const group of before.groups) for (const stop of group.stops) inBefore.set(stop, group.id);
  const inAfter = new Map<K, string>();
  for (const group of after.groups) for (const stop of group.stops) inAfter.set(stop, group.id);
  // A deleted group's stops leave with it; any other stop in no group now is taken out.
  for (const [stop, groupId] of inBefore) if (!inAfter.has(stop) && now.has(groupId)) ops.push({ type: 'stop.remove', stop });
  for (const group of after.groups)
    for (const stop of group.stops)
      if (inBefore.get(stop) !== group.id || !was.has(group.id)) ops.push({ type: 'stop.add', groupId: group.id, stop });

  let reached = applyGroupOps(before, ops);
  for (const group of after.groups) {
    const got = reached.groups.find((entry) => entry.id === group.id);
    if (got && !same(got.stops, group.stops)) ops.push({ type: 'stops.order', groupId: group.id, stops: [...group.stops] });
  }
  reached = applyGroupOps(before, ops);
  const order = after.groups.map((group) => group.id);
  if (!same(reached.groups.map((group) => group.id), order)) ops.push({ type: 'groups.order', groupIds: order });
  return ops;
}

/** Whether two sets of groups are the same, field for field and stop for stop. */
export function sameGroups<K>(one: LiveGroups<K>, other: LiveGroups<K>): boolean {
  return (
    one.groups.length === other.groups.length &&
    one.groups.every((group, index) => {
      const that = other.groups[index]!;
      return (
        group.id === that.id &&
        group.name === that.name &&
        group.color === that.color &&
        group.target === that.target &&
        same(group.stops, that.stops)
      );
    })
  );
}

/**
 * A batch with every stop put another way -- building ids to the browser's row
 * numbers and back. An operation about a stop that has no counterpart (a
 * property this browser does not draw) is left out; an order keeps the stops
 * that have one.
 */
export function mapOpStops<K, L>(ops: readonly GroupTemplateOp<K>[], map: (stop: K) => L | undefined): GroupTemplateOp<L>[] {
  return ops.flatMap((op): GroupTemplateOp<L>[] => {
    switch (op.type) {
      case 'stop.add':
      case 'stop.remove': {
        const stop = map(op.stop);
        return stop === undefined ? [] : [{ ...op, stop }];
      }
      case 'stops.order':
        return [{ ...op, stops: op.stops.flatMap((stop) => map(stop) ?? []) }];
      default:
        return [op];
    }
  });
}
