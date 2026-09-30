/**
 * Manual grouping: route groups built by hand on the Groups map.
 *
 * The office builds a group by clicking properties one at a time, each click
 * the next stop, and watches the route draw as it goes (2026-09-30). This is
 * the state that work lives in and every rule it follows -- what a click does,
 * undo and redo, the figures a group is judged by, the autosave and the export
 * -- kept apart from the map and the panel so it can be tested without either.
 *
 * A property is its **row number in the loaded file**. That is unique and
 * stable while the file is open; what survives a reload is a fingerprint of the
 * property instead (see `fingerprints`), because the autosave must not hold a
 * tenant's name or address.
 */

import { z } from 'zod';

import { groupColorOf, groupOutline, type FileGroup, type GroupFile, type GroupFileRow } from './group-file';
import { metresBetween } from './plan-groups';
import type { RoadRoute } from './road-routes';

/** A group being built. */
export interface ManualGroup {
  id: string;
  name: string;
  /** `#rrggbb`. */
  color: string;
  /** How many stops it is meant to hold; it takes no more until raised. */
  target: number;
  /** Row numbers, in visiting order. */
  stops: number[];
}

export interface ManualState {
  /** In the order the panel lists them, which is the order they are numbered and exported in. */
  groups: ManualGroup[];
}

export const EMPTY_STATE: ManualState = { groups: [] };

/** A new group's size unless changed: a day of nine (the office, 2026-09-19). */
export const DEFAULT_TARGET = 9;

/**
 * Twenty colours chosen to be told apart, and none of them green.
 *
 * Kenneth Kelly's colours of maximum contrast, without white, black and grey.
 * Green is what an ungrouped property is drawn in (2026-09-30), so his greens
 * -- and the teal and dark olive that stood beside them -- gave way to a navy,
 * an indigo, an azure and a light magenta, each picked as far as possible from
 * the rest. The nearest preset now stands 0.25 from the ungrouped green in
 * OKLab; the greens stood 0.09 to 0.12.
 */
export const COLOR_PRESETS = [
  '#f3c300',
  '#875692',
  '#f38400',
  '#a1caf1',
  '#be0032',
  '#000099',
  '#d100d1',
  '#4c00ff',
  '#e68fac',
  '#0067a5',
  '#f99379',
  '#604e97',
  '#f6a600',
  '#b3446c',
  '#dcd300',
  '#882d17',
  '#3399ff',
  '#654522',
  '#e25822',
  '#ff66ff',
] as const;

/** How long a visit takes, for the estimated day: half an hour unless changed. */
export const DEFAULT_MINUTES_PER_PROPERTY = 30;

/** The day a group makes: its drive, and its stops at so many minutes each. */
export function estDaySeconds(driveSeconds: number, stops: number, minutesPerProperty: number): number {
  return driveSeconds + stops * minutesPerProperty * 60;
}

/** Every property in the file, grouped or not, in the file's own order. */
export function propertiesOf(file: GroupFile): GroupFileRow[] {
  return [...file.groups.flatMap((group) => group.rows), ...file.ungrouped].sort(
    (left, right) => left.rowNumber - right.rowNumber,
  );
}

export function newGroupId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** "Group N", with N the first number no group is already called by. */
export function nextGroupName(state: ManualState): string {
  const taken = new Set(state.groups.map((group) => group.name.trim().toLowerCase()));
  let number = state.groups.length + 1;
  while (taken.has(`group ${number}`)) number += 1;
  return `Group ${number}`;
}

/** The first preset no group has; round again once all twenty are used. */
export function nextPresetColor(state: ManualState): string {
  const used = new Set(state.groups.map((group) => group.color.toLowerCase()));
  return COLOR_PRESETS.find((color) => !used.has(color)) ?? COLOR_PRESETS[state.groups.length % COLOR_PRESETS.length]!;
}

/* ------------------------------------------------------------------------ */
/* Edits, and the history they are undone through                            */
/* ------------------------------------------------------------------------ */

export type ManualEdit =
  | { type: 'create'; group: ManualGroup }
  | { type: 'update'; id: string; changes: Partial<Pick<ManualGroup, 'name' | 'color' | 'target'>> }
  /** Its properties go back to ungrouped. */
  | { type: 'delete'; id: string }
  /** The next stop of group `id`, from ungrouped or from another group. */
  | { type: 'add'; id: string; row: number }
  /** Out of whichever group holds it; the stops after it move up one. */
  | { type: 'remove'; row: number }
  | { type: 'reorder'; id: string; from: number; to: number }
  /** The whole visiting order at once: the fastest order, worked out from drive times. */
  | { type: 'order'; id: string; stops: number[] };

/** The state after an edit, or the same object when the edit changes nothing. */
export function applyEdit(state: ManualState, edit: ManualEdit): ManualState {
  const withGroups = (groups: ManualGroup[]) => ({ ...state, groups });
  switch (edit.type) {
    case 'create':
      return withGroups([...state.groups, edit.group]);
    case 'update': {
      if (!state.groups.some((group) => group.id === edit.id)) return state;
      return withGroups(state.groups.map((group) => (group.id === edit.id ? { ...group, ...edit.changes } : group)));
    }
    case 'delete': {
      if (!state.groups.some((group) => group.id === edit.id)) return state;
      return withGroups(state.groups.filter((group) => group.id !== edit.id));
    }
    case 'add': {
      if (!state.groups.some((group) => group.id === edit.id)) return state;
      // Out of any group first: a property is in one group at most, so an add
      // from another group is a move.
      return withGroups(
        state.groups.map((group) => {
          const without = group.stops.filter((row) => row !== edit.row);
          return group.id === edit.id ? { ...group, stops: [...without, edit.row] } : without.length === group.stops.length ? group : { ...group, stops: without };
        }),
      );
    }
    case 'remove': {
      if (!state.groups.some((group) => group.stops.includes(edit.row))) return state;
      return withGroups(
        state.groups.map((group) =>
          group.stops.includes(edit.row) ? { ...group, stops: group.stops.filter((row) => row !== edit.row) } : group,
        ),
      );
    }
    case 'reorder': {
      const group = state.groups.find((entry) => entry.id === edit.id);
      if (!group || edit.from === edit.to) return state;
      if (edit.from < 0 || edit.from >= group.stops.length || edit.to < 0 || edit.to >= group.stops.length) return state;
      const stops = [...group.stops];
      const [moved] = stops.splice(edit.from, 1);
      stops.splice(edit.to, 0, moved!);
      return withGroups(state.groups.map((entry) => (entry.id === edit.id ? { ...entry, stops } : entry)));
    }
    case 'order': {
      const group = state.groups.find((entry) => entry.id === edit.id);
      if (!group) return state;
      // The same stops in another order, or nothing: an order worked out for a
      // group that has since gained or lost a stop is not this group's.
      const same =
        edit.stops.length === group.stops.length &&
        new Set(edit.stops).size === edit.stops.length &&
        edit.stops.every((row) => group.stops.includes(row));
      if (!same || edit.stops.every((row, index) => row === group.stops[index])) return state;
      return withGroups(state.groups.map((entry) => (entry.id === edit.id ? { ...entry, stops: [...edit.stops] } : entry)));
    }
  }
}

export interface ManualHistory {
  past: ManualState[];
  present: ManualState;
  future: ManualState[];
}

export type HistoryAction =
  /**
   * `amend`: part of the last step rather than a step of its own -- the stops
   * put in the fastest order after a click, which one undo takes back together
   * with the click.
   */
  | { type: 'edit'; edit: ManualEdit; amend?: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  /** A fresh start -- blank, from the file, or resumed: nothing before it to undo. */
  | { type: 'reset'; state: ManualState };

/** How far back undo reaches. A session of building 39 groups is well inside it. */
const HISTORY_LIMIT = 500;

export function historyReducer(history: ManualHistory, action: HistoryAction): ManualHistory {
  switch (action.type) {
    case 'edit': {
      const next = applyEdit(history.present, action.edit);
      if (next === history.present) return history;
      if (action.amend && history.past.length) return { past: history.past, present: next, future: [] };
      return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: next, future: [] };
    }
    case 'undo': {
      const previous = history.past[history.past.length - 1];
      if (!previous) return history;
      return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
    }
    case 'redo': {
      const [next, ...rest] = history.future;
      if (!next) return history;
      return { past: [...history.past, history.present], present: next, future: rest };
    }
    case 'reset':
      return { past: [], present: action.state, future: [] };
  }
}

/* ------------------------------------------------------------------------ */
/* What a click on the map does                                              */
/* ------------------------------------------------------------------------ */

export type ClickIntent =
  /** No group is being built: nothing to add it to. */
  | { kind: 'no-active' }
  /** Already a stop of the active group: take it out. */
  | { kind: 'remove'; group: ManualGroup }
  /** The active group has all the stops it is meant to: say so, change nothing. */
  | { kind: 'full'; group: ManualGroup }
  /** In another group: ask before taking it from there. */
  | { kind: 'move'; from: ManualGroup; to: ManualGroup }
  /** Ungrouped: the active group's next stop. */
  | { kind: 'add'; group: ManualGroup };

export function clickIntent(state: ManualState, activeId: string | null, row: number): ClickIntent {
  const active = state.groups.find((group) => group.id === activeId);
  if (!active) return { kind: 'no-active' };
  if (active.stops.includes(row)) return { kind: 'remove', group: active };
  if (active.stops.length >= active.target) return { kind: 'full', group: active };
  const owner = state.groups.find((group) => group.stops.includes(row));
  return owner ? { kind: 'move', from: owner, to: active } : { kind: 'add', group: active };
}

/* ------------------------------------------------------------------------ */
/* What a group is judged by                                                 */
/* ------------------------------------------------------------------------ */

const METRES_PER_MILE = 1609.344;

/** Straight lines from stop to stop, in order, in miles. Not the road: that needs a router. */
export function routeMiles(rows: readonly { latitude: number; longitude: number }[]): number {
  let metres = 0;
  for (let index = 1; index < rows.length; index += 1) metres += metresBetween(rows[index - 1]!, rows[index]!);
  return metres / METRES_PER_MILE;
}

/** Its two most common cities, "Katy / Fulshear" -- the office's own way of naming an area. */
export function groupArea(rows: readonly GroupFileRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const city = row.city?.trim();
    if (city) counts.set(city, (counts.get(city) ?? 0) + 1);
  }
  // Most common first; a tie goes to the city the route reaches first.
  const cities = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([city]) => city);
  return cities.length ? cities.slice(0, 2).join(' / ') : null;
}

/**
 * The groups as the map draws them: numbered in list order, each stop numbered
 * in its place, in the group's colour, with its outline. Empty groups are left
 * out -- there is nothing of them to draw.
 */
export function drawnGroups(state: ManualState, byRow: ReadonlyMap<number, GroupFileRow>): FileGroup[] {
  return state.groups.flatMap((group, index): FileGroup[] => {
    const rows = group.stops.flatMap((rowNumber, stop) => {
      const row = byRow.get(rowNumber);
      return row ? [{ ...row, group: group.id, stop: stop + 1 }] : [];
    });
    if (!rows.length) return [];
    const outline = groupOutline(rows);
    const top = outline.reduce((highest, point) => (point[1] > highest[1] ? point : highest));
    return [
      {
        key: group.id,
        label: String(index + 1),
        name: group.name,
        area: groupArea(rows),
        rows,
        size: rows.length,
        spanMiles: null,
        routeMiles: routeMiles(rows),
        driveMinutes: null,
        longestHopMinutes: null,
        longHop: null,
        color: groupColorOf(group.color) ?? { fill: '#6b7280', ink: '#ffffff' },
        outline,
        labelAt: { latitude: top[1], longitude: top[0] },
      },
    ];
  });
}

/* ------------------------------------------------------------------------ */
/* Starting                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The loaded file's groups, to edit: its names and colours where it has them
 * (a file exported from here), "Group N" and the map's colour where it does
 * not. Each is as full as it is, so it takes no more until raised.
 */
export function fromFile(file: GroupFile): ManualState {
  return {
    groups: file.groups.map((group) => ({
      id: newGroupId(),
      name: group.name ?? `Group ${group.key}`,
      color: group.color.fill,
      target: Math.max(group.size, group.rows.length),
      stops: group.rows.map((row) => row.rowNumber),
    })),
  };
}

/* ------------------------------------------------------------------------ */
/* The autosave                                                              */
/* ------------------------------------------------------------------------ */

/** Versioned, so a later shape is refused rather than misread. */
export const SAVE_KEY = 'texasrenters:manual-grouping:v1';

/**
 * cyrb53: a fast 53-bit string hash. Not cryptographic, and not meant to be --
 * it only has to tell 395 properties apart and not spell out whose they are.
 */
function cyrb53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A short fingerprint of any text: what this browser keeps in place of addresses and positions. */
export const hashText = (text: string) => cyrb53(text);

/**
 * A fingerprint per property, by row number: what the autosave keeps instead
 * of the property, so the browser's storage never holds a tenant's name or
 * address. Made from what the property is -- address, unit, city, zip, lease
 * and position -- so it finds the same property in another file of the same
 * portfolio, whatever row it is on there. Two rows alike in all of that (none
 * in the office's files) are told apart by the order they come in.
 */
export function fingerprints(properties: readonly GroupFileRow[]): Map<number, string> {
  const seen = new Map<string, number>();
  const result = new Map<number, string>();
  for (const row of properties) {
    const identity = [
      row.address,
      row.unit ?? '',
      row.city ?? '',
      row.zip ?? '',
      row.lease ?? '',
      row.cells.latitude ?? String(row.latitude),
      row.cells.longitude ?? String(row.longitude),
    ].join('\u001f');
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);
    result.set(row.rowNumber, cyrb53(occurrence ? `${identity}\u001f${occurrence}` : identity));
  }
  return result;
}

const savedSchema = z.object({
  version: z.literal(1),
  /** The file it was built on, to reopen by itself only over that file. */
  fileName: z.string().max(260),
  /** Whether manual grouping was open when it was last saved. */
  open: z.boolean(),
  savedAt: z.string().max(40),
  activeId: z.string().max(100).nullable(),
  /** The estimated day's minutes per visit. Absent in work saved before it existed. */
  minutesPerProperty: z.number().int().min(0).max(600).optional(),
  /** Whether a group's route is optimized again after every add. Absent before it existed: off. */
  autoOrder: z.boolean().optional(),
  groups: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().max(200),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        target: z.number().int().min(1).max(999),
        stops: z.array(z.string().max(40)).max(5000),
      }),
    )
    .max(1000),
});

export type SavedGrouping = z.infer<typeof savedSchema>;

export function toSaved(
  state: ManualState,
  activeId: string | null,
  prints: ReadonlyMap<number, string>,
  fileName: string,
  open: boolean,
  settings: { minutesPerProperty?: number; autoOrder?: boolean } = {},
): SavedGrouping {
  return {
    version: 1,
    fileName,
    open,
    savedAt: new Date().toISOString(),
    activeId,
    minutesPerProperty: settings.minutesPerProperty ?? DEFAULT_MINUTES_PER_PROPERTY,
    autoOrder: settings.autoOrder ?? false,
    groups: state.groups.map((group) => ({
      ...group,
      stops: group.stops.flatMap((row) => {
        const print = prints.get(row);
        return print ? [print] : [];
      }),
    })),
  };
}

/**
 * The saved groups over the properties now loaded. A stop whose property is not
 * in this file is dropped and counted, rather than guessed at.
 */
export function fromSaved(
  saved: SavedGrouping,
  prints: ReadonlyMap<number, string>,
): { state: ManualState; activeId: string | null; missing: number; minutesPerProperty: number; autoOrder: boolean } {
  const rowOf = new Map([...prints].map(([row, print]) => [print, row]));
  const placed = new Set<number>();
  let missing = 0;
  const groups = saved.groups.map((group) => ({
    ...group,
    color: group.color.toLowerCase(),
    stops: group.stops.flatMap((print) => {
      const row = rowOf.get(print);
      if (row === undefined || placed.has(row)) {
        if (row === undefined) missing += 1;
        return [];
      }
      placed.add(row);
      return [row];
    }),
  }));
  const activeId = groups.some((group) => group.id === saved.activeId) ? saved.activeId : null;
  return {
    state: { groups },
    activeId,
    missing,
    minutesPerProperty: saved.minutesPerProperty ?? DEFAULT_MINUTES_PER_PROPERTY,
    autoOrder: saved.autoOrder ?? false,
  };
}

/** The saved work, if there is any and it reads. Storage can be missing or refused. */
export function readSaved(): SavedGrouping | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = savedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSaved(saved: SavedGrouping): void {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    // Full or refused: the work stays on the page; only a reload would lose it.
  }
}

/* ------------------------------------------------------------------------ */
/* The export                                                                */
/* ------------------------------------------------------------------------ */

/** Written from here at the end of every row, in this order, whatever the loaded file had. */
const WRITTEN_AT_END = [
  'group_drive_minutes',
  'group_drive_miles',
  'leg_minutes',
  'est_day_minutes',
  'group_name',
  'group_color',
];

/**
 * Left out: the span, and the longest hop, which were the office tool's own
 * measures -- a group built here has neither, and a stale one is worse than
 * none -- and the columns written at the end, so they are not there twice.
 */
const NOT_EXPORTED = new Set(['group_span_miles', 'longest_hop_minutes', ...WRITTEN_AT_END]);

/** The columns written here rather than copied from the property's own row. */
const GROUP_COLUMNS = new Set(['group', 'group_area', 'stop', 'group_route_miles', 'group_size', ...WRITTEN_AT_END]);

/** The drive, for the export's drive columns. */
export interface ExportDrive {
  /** Each group's road route by group id, where Mapbox has answered. */
  routes: ReadonlyMap<string, RoadRoute>;
  minutesPerProperty: number;
}

/** One CSV cell, quoted when it has to be, its quotes doubled. */
function csvCell(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The work as a groups file, in the office's own layout: the loaded file's
 * columns in its order, every property's own cells exactly as they were read,
 * and the group's -- its number, area, stop, size and straight-line miles --
 * written from here. Then its drive from the road routes: total minutes and
 * miles, each stop's minutes from the one before, and the estimated day; blank
 * for a group Mapbox could not route. `group_name` and `group_color` close each
 * row so the file comes back as it was made. Properties in no group follow,
 * with their group blank.
 */
export function exportCsv(
  file: GroupFile,
  state: ManualState,
  properties: readonly GroupFileRow[],
  drive?: ExportDrive,
): string {
  let header = file.header.filter((name) => name && !NOT_EXPORTED.has(name));
  header = [...['group', 'group_area', 'stop'].filter((name) => !header.includes(name)), ...header];
  for (const name of ['group_route_miles', 'group_size']) if (!header.includes(name)) header.push(name);
  header.push(...WRITTEN_AT_END);

  const byRow = new Map(properties.map((row) => [row.rowNumber, row]));
  const lines: string[][] = [header];
  const grouped = new Set<number>();
  let number = 0;
  for (const group of state.groups) {
    const rows = group.stops.flatMap((row) => byRow.get(row) ?? []);
    if (!rows.length) continue;
    number += 1;
    // One stop drives nowhere; otherwise the route has to be for these stops.
    const route = rows.length === 1 ? null : drive?.routes.get(group.id);
    const known = rows.length === 1 || (route !== undefined && route !== null && route.legs.length === rows.length - 1);
    const driveSeconds = route?.durationS ?? 0;
    const written: Record<string, string> = {
      group: String(number),
      group_area: groupArea(rows) ?? '',
      group_route_miles: routeMiles(rows).toFixed(1),
      group_size: String(rows.length),
      group_drive_minutes: known ? String(Math.round(driveSeconds / 60)) : '',
      group_drive_miles: known ? ((route?.distanceM ?? 0) / METRES_PER_MILE).toFixed(1) : '',
      est_day_minutes:
        known && drive ? String(Math.round(estDaySeconds(driveSeconds, rows.length, drive.minutesPerProperty) / 60)) : '',
      group_name: group.name,
      group_color: group.color,
    };
    rows.forEach((row, stop) => {
      grouped.add(row.rowNumber);
      const leg = stop > 0 && route ? route.legs[stop - 1] : undefined;
      const cell = (name: string) =>
        name === 'stop'
          ? String(stop + 1)
          : name === 'leg_minutes'
            ? leg
              ? String(Math.round(leg.durationS / 60))
              : ''
            : (written[name] ?? row.cells[name] ?? '');
      lines.push(header.map(cell));
    });
  }
  for (const row of properties)
    if (!grouped.has(row.rowNumber))
      lines.push(header.map((name) => (GROUP_COLUMNS.has(name) ? '' : (row.cells[name] ?? ''))));

  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
