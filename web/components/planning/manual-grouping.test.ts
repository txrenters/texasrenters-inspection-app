import { describe, expect, it } from 'vitest';

import { nearUngroupedGreen, readGroupFile } from './group-file';
import {
  applyEdit,
  clickIntent,
  COLOR_PRESETS,
  drawnGroups,
  EMPTY_STATE,
  exportCsv,
  fingerprints,
  fromFile,
  fromSaved,
  groupArea,
  historyReducer,
  nextGroupName,
  nextPresetColor,
  propertiesOf,
  routeMiles,
  toSaved,
  type ManualGroup,
  type ManualHistory,
  type ManualState,
} from './manual-grouping';
import type { RoadRoute } from './road-routes';

/**
 * Manual grouping: route groups built by hand on the Groups map.
 *
 * Every property here is invented. The real file names tenants and their
 * homes, and this repository is public.
 */

const HEADER =
  'group,group_area,stop,address,city,zip,unit,lease,zone,hvac_plan,matched_to_property,latitude,longitude,group_span_miles,group_route_miles,geocode_source,group_size,group_drive_minutes,longest_hop_minutes';

/** Six properties in two groups of three, the second one's last stop at a zip code's centre. */
const FILE = readGroupFile(
  [
    HEADER,
    '1,Katy,1,1 Elm St,Katy,77494,,"Doe, J.",2,On our AC Plan,t,29.780000,-95.80,4.0,5.1,address,3,20,8',
    '1,Katy,2,2 Elm St,Katy,77494,,Roe,2,Not Completed,t,29.790000,-95.80,4.0,5.1,address,3,20,8',
    '1,Katy,3,3 Elm St,Fulshear,77441,,Poe,2,,t,29.800000,-95.80,4.0,5.1,address,3,20,8',
    '2,Houston,1,4 Oak St,Houston,77009,A,Moe,1,,t,29.760000,-95.37,2.0,3.0,address,3,15,6',
    '2,Houston,2,4 Oak St,Houston,77009,B,Low,1,,t,29.760000,-95.37,2.0,3.0,address,3,15,6',
    '2,Houston,3,6 Oak St,Houston,77009,,Bow,1,,t,29.770000,-95.36,2.0,3.0,zip centroid,3,15,6',
  ].join('\r\n'),
);
const PROPERTIES = propertiesOf(FILE);
const BY_ROW = new Map(PROPERTIES.map((row) => [row.rowNumber, row]));
/** Row numbers: the header is row 1, so the six properties are rows 2 to 7. */
const [ELM1, ELM2, ELM3, OAK_A, OAK_B, OAK6] = [2, 3, 4, 5, 6, 7];

const group = (id: string, stops: number[], extra: Partial<ManualGroup> = {}): ManualGroup => ({
  id,
  name: `Group ${id}`,
  color: '#0067a5',
  target: 3,
  stops,
  ...extra,
});

describe('building a group by clicking', () => {
  it('adds an ungrouped property as the next stop of the group being built', () => {
    const state: ManualState = { groups: [group('a', [ELM1], { target: 9 })] };
    expect(clickIntent(state, 'a', ELM2)).toMatchObject({ kind: 'add' });
    expect(applyEdit(state, { type: 'add', id: 'a', row: ELM2 }).groups[0]!.stops).toEqual([ELM1, ELM2]);
  });

  it('takes a stop of the active group out, and the stops after it move up one', () => {
    const state: ManualState = { groups: [group('a', [ELM1, ELM2, ELM3])] };
    expect(clickIntent(state, 'a', ELM2)).toMatchObject({ kind: 'remove' });
    const after = applyEdit(state, { type: 'remove', row: ELM2 });
    expect(after.groups[0]!.stops).toEqual([ELM1, ELM3]);
    // Stop numbers are places in the list: ELM3 is stop 2 now.
    expect(drawnGroups(after, BY_ROW)[0]!.rows.map((row) => [row.rowNumber, row.stop])).toEqual([
      [ELM1, 1],
      [ELM3, 2],
    ]);
  });

  it('asks before taking a property from another group, and moves it as the next stop', () => {
    const state: ManualState = { groups: [group('a', [ELM1], { target: 9 }), group('b', [OAK_A, OAK_B])] };
    const intent = clickIntent(state, 'a', OAK_A);
    expect(intent).toMatchObject({ kind: 'move', from: { id: 'b' }, to: { id: 'a' } });
    const after = applyEdit(state, { type: 'add', id: 'a', row: OAK_A });
    expect(after.groups.map((entry) => entry.stops)).toEqual([[ELM1, OAK_A], [OAK_B]]);
  });

  it('says a full group is full, and takes nothing more into it -- not even from another group', () => {
    const state: ManualState = { groups: [group('a', [ELM1, ELM2, ELM3]), group('b', [OAK_A])] };
    expect(clickIntent(state, 'a', OAK6)).toMatchObject({ kind: 'full' });
    expect(clickIntent(state, 'a', OAK_A)).toMatchObject({ kind: 'full' });
    // Removing is still allowed.
    expect(clickIntent(state, 'a', ELM3)).toMatchObject({ kind: 'remove' });
  });

  it('adds nothing when no group is being built', () => {
    expect(clickIntent({ groups: [group('a', [])] }, null, ELM1)).toEqual({ kind: 'no-active' });
  });

  it('reorders the stops, and deleting a group returns its properties to ungrouped', () => {
    const state: ManualState = { groups: [group('a', [ELM1, ELM2, ELM3])] };
    expect(applyEdit(state, { type: 'reorder', id: 'a', from: 2, to: 0 }).groups[0]!.stops).toEqual([ELM3, ELM1, ELM2]);
    expect(applyEdit(state, { type: 'delete', id: 'a' }).groups).toEqual([]);
  });
});

describe('undo and redo', () => {
  const start: ManualHistory = { past: [], present: { groups: [group('a', [], { target: 9 })] }, future: [] };
  const edits = [
    { type: 'add', id: 'a', row: ELM1 },
    { type: 'add', id: 'a', row: ELM2 },
    { type: 'remove', row: ELM1 },
  ] as const;
  const built = edits.reduce((history, edit) => historyReducer(history, { type: 'edit', edit }), start);

  it('steps back through adds and removes, and forward again', () => {
    expect(built.present.groups[0]!.stops).toEqual([ELM2]);
    const undone = historyReducer(built, { type: 'undo' });
    expect(undone.present.groups[0]!.stops).toEqual([ELM1, ELM2]);
    const twice = historyReducer(undone, { type: 'undo' });
    expect(twice.present.groups[0]!.stops).toEqual([ELM1]);
    expect(historyReducer(twice, { type: 'redo' }).present.groups[0]!.stops).toEqual([ELM1, ELM2]);
  });

  it('forgets what was undone once something new is done', () => {
    const undone = historyReducer(built, { type: 'undo' });
    const branched = historyReducer(undone, { type: 'edit', edit: { type: 'add', id: 'a', row: ELM3 } });
    expect(branched.future).toEqual([]);
  });

  /** A click and the reordering it caused are one step: one undo takes back both. */
  it('folds the fastest order into the click that caused it', () => {
    const clicked = historyReducer(start, { type: 'edit', edit: { type: 'add', id: 'a', row: ELM1 } });
    const twice = historyReducer(clicked, { type: 'edit', edit: { type: 'add', id: 'a', row: ELM2 } });
    const ordered = historyReducer(twice, {
      type: 'edit',
      edit: { type: 'order', id: 'a', stops: [ELM2, ELM1] },
      amend: true,
    });
    expect(ordered.present.groups[0]!.stops).toEqual([ELM2, ELM1]);
    expect(ordered.past).toHaveLength(2);
    expect(historyReducer(ordered, { type: 'undo' }).present.groups[0]!.stops).toEqual([ELM1]);
  });

  it('takes an order only of the same stops', () => {
    const state: ManualState = { groups: [group('a', [ELM1, ELM2, ELM3])] };
    expect(applyEdit(state, { type: 'order', id: 'a', stops: [ELM3, ELM1, ELM2] }).groups[0]!.stops).toEqual([ELM3, ELM1, ELM2]);
    // A stop gained, lost or doubled since the order was worked out: not this group's order.
    expect(applyEdit(state, { type: 'order', id: 'a', stops: [ELM3, ELM1] })).toBe(state);
    expect(applyEdit(state, { type: 'order', id: 'a', stops: [ELM3, ELM1, OAK6] })).toBe(state);
    expect(applyEdit(state, { type: 'order', id: 'a', stops: [ELM1, ELM1, ELM2] })).toBe(state);
  });

  it('keeps no step for an edit that changes nothing', () => {
    expect(historyReducer(built, { type: 'edit', edit: { type: 'remove', row: OAK6 } })).toBe(built);
    expect(historyReducer(start, { type: 'undo' })).toBe(start);
  });
});

describe('a group’s figures', () => {
  it('measures the route in straight lines from stop to stop, in order, in miles', () => {
    // 0.01 degrees of latitude is about 0.69 miles.
    const miles = routeMiles([BY_ROW.get(ELM1)!, BY_ROW.get(ELM2)!, BY_ROW.get(ELM3)!]);
    expect(miles).toBeCloseTo(1.38, 1);
    expect(routeMiles([BY_ROW.get(ELM1)!])).toBe(0);
  });

  it('names its area by its two most common cities', () => {
    expect(groupArea([BY_ROW.get(ELM1)!, BY_ROW.get(ELM3)!, BY_ROW.get(ELM2)!])).toBe('Katy / Fulshear');
    expect(groupArea([BY_ROW.get(OAK_A)!])).toBe('Houston');
  });

  it('draws groups numbered in list order, and leaves out one with no stops', () => {
    const drawn = drawnGroups({ groups: [group('a', []), group('b', [OAK_A])] }, BY_ROW);
    expect(drawn.map((entry) => [entry.key, entry.label])).toEqual([['b', '2']]);
  });

  it('suggests the next free name and a colour no group has', () => {
    const state: ManualState = { groups: [group('a', [], { name: 'Group 2', color: COLOR_PRESETS[0] })] };
    expect(nextGroupName(state)).toBe('Group 3');
    expect(nextGroupName(EMPTY_STATE)).toBe('Group 1');
    expect(nextPresetColor(state)).toBe(COLOR_PRESETS[1]);
  });

  it('offers twenty distinct preset colours', () => {
    expect(new Set(COLOR_PRESETS).size).toBe(20);
  });

  /** Green is what an ungrouped property is drawn in (2026-09-30): no preset may pass for it. */
  it('offers no preset that could be taken for the ungrouped green', () => {
    for (const preset of COLOR_PRESETS) expect(nearUngroupedGreen(preset)).toBe(false);
    expect(nearUngroupedGreen('#16a34a')).toBe(true);
    expect(nearUngroupedGreen('#22c55e')).toBe(true);
    expect(nearUngroupedGreen('#0067a5')).toBe(false);
  });
});

describe('starting from the loaded file', () => {
  it('takes its groups, in its order, full as they are', () => {
    const state = fromFile(FILE);
    expect(state.groups.map((entry) => [entry.name, entry.stops, entry.target])).toEqual([
      ['Group 1', [ELM1, ELM2, ELM3], 3],
      ['Group 2', [OAK_A, OAK_B, OAK6], 3],
    ]);
    expect(state.groups[0]!.color).toBe(FILE.groups[0]!.color.fill);
  });
});

describe('the autosave', () => {
  const prints = fingerprints(PROPERTIES);
  const state: ManualState = { groups: [group('a', [ELM2, ELM1]), group('b', [OAK_B])] };

  it('tells apart units at one address', () => {
    expect(new Set(prints.values()).size).toBe(PROPERTIES.length);
    expect(prints.get(OAK_A)).not.toBe(prints.get(OAK_B));
  });

  /** It lives in the browser's storage: fingerprints, never an address or a tenant. */
  it('holds no address and no tenant', () => {
    const saved = JSON.stringify(toSaved(state, 'a', prints, 'groups.csv', true));
    for (const text of ['Elm', 'Oak', 'Doe', 'Moe', 'Katy', '29.78']) expect(saved).not.toContain(text);
  });

  it('comes back as it was, over the same properties in another order', () => {
    const saved = toSaved(state, 'a', prints, 'groups.csv', true);
    const reversed = [...PROPERTIES].reverse().map((row, index) => ({ ...row, rowNumber: 100 + index }));
    const restored = fromSaved(saved, fingerprints(reversed));
    const addressOf = (row: number) => reversed.find((entry) => entry.rowNumber === row)!.address;
    expect(restored.state.groups[0]!.stops.map(addressOf)).toEqual(['2 Elm St', '1 Elm St']);
    expect(restored.activeId).toBe('a');
    expect(restored.missing).toBe(0);
  });

  it('counts a saved stop whose property is not in the file, and leaves it out', () => {
    const saved = toSaved(state, null, prints, 'groups.csv', false);
    const restored = fromSaved(saved, fingerprints(PROPERTIES.filter((row) => row.rowNumber !== ELM1)));
    expect(restored.missing).toBe(1);
    expect(restored.state.groups[0]!.stops).toHaveLength(1);
  });
});

describe('the export', () => {
  const state: ManualState = {
    groups: [group('a', [ELM3, ELM1], { name: 'Katy, north', color: '#be0032' }), group('empty', []), group('b', [OAK6])],
  };
  /** Group a's road route, as Mapbox would give it: one 17-minute, five-mile leg. */
  const route: RoadRoute = {
    geometry: [
      [-95.8, 29.8],
      [-95.8, 29.78],
    ],
    durationS: 17 * 60,
    distanceM: 5 * 1609.344,
    legs: [{ durationS: 17 * 60, distanceM: 5 * 1609.344 }],
    splits: [0, 1],
  };
  const csv = exportCsv(FILE, state, PROPERTIES, { routes: new Map([['a', route]]), minutesPerProperty: 30 });
  const lines = csv.trimEnd().split('\r\n');

  it('follows the loaded file’s columns, drops the span and longest hop, and adds the drive, the day, the name and colour', () => {
    expect(lines[0]).toBe(
      'group,group_area,stop,address,city,zip,unit,lease,zone,hvac_plan,matched_to_property,latitude,longitude,group_route_miles,geocode_source,group_size,group_drive_minutes,group_drive_miles,leg_minutes,est_day_minutes,group_name,group_color',
    );
  });

  it('numbers the groups with stops in order, and copies each property’s own cells exactly', () => {
    // The drive from Mapbox: 17 min and 5.0 mi, no leg into stop 1, and a day of 17 + 2 × 30 = 77 min.
    expect(lines[1]).toBe(
      '1,Fulshear / Katy,1,3 Elm St,Fulshear,77441,,Poe,2,,t,29.800000,-95.80,1.4,address,2,17,5.0,,77,"Katy, north",#be0032',
    );
    expect(lines[2]).toContain(',"Doe, J.",2,On our AC Plan,t,29.780000,');
    // Stop 2 carries the leg from stop 1.
    expect(lines[2]!.endsWith(',address,2,17,5.0,17,77,"Katy, north",#be0032')).toBe(true);
    // The empty group is skipped, so the next is 2, not 3; one stop drives nowhere, and its day is its visit.
    expect(lines[3]!.startsWith('2,Houston,1,6 Oak St,')).toBe(true);
    expect(lines[3]!.endsWith(',zip centroid,1,0,0.0,,30,Group b,#0067a5')).toBe(true);
  });

  it('lists the properties in no group, with their group blank', () => {
    expect(lines).toHaveLength(1 + 3 + 3);
    expect(lines[4]!.startsWith(',,,2 Elm St,')).toBe(true);
    expect(lines[4]!.endsWith(',address,,,,,,,')).toBe(true);
  });

  /** A group Mapbox could not route has no drive to write: blank, not a guess. */
  it('leaves the drive blank for a group with no road route', () => {
    const unrouted = exportCsv(FILE, state, PROPERTIES, { routes: new Map(), minutesPerProperty: 30 }).split('\r\n');
    expect(unrouted[1]!.endsWith(',address,2,,,,,"Katy, north",#be0032')).toBe(true);
  });

  /** "Choose another file" loads an export back in, names and colours and all. */
  it('reads back in as the same groups, names and colours, with the rest ungrouped', () => {
    const back = readGroupFile(csv);
    expect(back.groups.map((entry) => [entry.name, entry.color.fill, entry.rows.map((row) => row.address)])).toEqual([
      ['Katy, north', '#be0032', ['3 Elm St', '1 Elm St']],
      ['Group b', '#0067a5', ['6 Oak St']],
    ]);
    expect(back.ungrouped.map((row) => row.address)).toEqual(['2 Elm St', '4 Oak St', '4 Oak St']);
    expect(back.groups[1]!.rows[0]!.approximate).toBe(true);
    // And into manual grouping again, as it was left.
    expect(fromFile(back).groups.map((entry) => entry.name)).toEqual(['Katy, north', 'Group b']);
  });
});
