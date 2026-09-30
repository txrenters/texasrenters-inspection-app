import { describe, expect, it } from 'vitest';

import type { GroupMakerProperty } from '@/lib/planning-queries';

import { readGroupFile } from './group-file';
import {
  makerProperties,
  rowsToMatch,
  sameTemplate,
  stateFromMatchedFile,
  stateFromTemplate,
  templateInput,
} from './group-maker';

/**
 * The Group maker (2026-09-30): the manual grouping over the database's
 * properties, saved as a template of buildings.
 */

const property = (buildingId: string, extra: Partial<GroupMakerProperty> = {}): GroupMakerProperty => ({
  buildingId,
  address: `${buildingId} Main St`,
  city: 'Houston',
  postalCode: '77009',
  latitude: 29.8,
  longitude: -95.4,
  approximate: false,
  zone: '1',
  hvacPlans: ['On our AC Plan'],
  leases: ['Tenant'],
  units: [],
  ...extra,
});

describe('the maker’s properties as rows', () => {
  it('is a row per building, numbered like a file’s, every one in no group', () => {
    const made = makerProperties([
      property('b1', { units: ['House', '1/2'], leases: ['Smith', 'Jones'] }),
      property('b2', { approximate: true }),
    ]);

    expect(made.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(made.file.ungrouped).toHaveLength(2);
    expect(made.file.groups).toEqual([]);
    expect(made.rows[0]).toMatchObject({ unit: 'House, 1/2', lease: 'Smith · Jones', zone: '1', approximate: false });
    expect(made.rows[1]).toMatchObject({ approximate: true, geocodeSource: 'zip centroid' });
    expect(made.rowOf.get('b2')).toBe(3);
    expect(made.buildingOf.get(2)).toBe('b1');
  });
});

describe('a template, opened and saved', () => {
  const made = makerProperties([property('b1'), property('b2'), property('b3')]);

  it('opens as groups of rows in the order saved, leaving out a building no longer there', () => {
    const { state, missing } = stateFromTemplate(
      {
        groups: [
          { position: 1, name: 'North', color: '#e6194b', target: 9, buildingIds: ['b3', 'gone', 'b1'] },
          { position: 2, name: 'South', color: '#4363d8', target: 10, buildingIds: ['b2'] },
        ],
      },
      made.rowOf,
    );

    expect(state.groups.map((group) => [group.name, group.stops])).toEqual([
      ['North', [4, 2]],
      ['South', [3]],
    ]);
    expect(missing).toBe(1);
  });

  it('saves as buildings in driving order, and a round trip changes nothing', () => {
    const { state } = stateFromTemplate(
      { groups: [{ position: 1, name: 'North', color: '#e6194b', target: 9, buildingIds: ['b3', 'b1'] }] },
      made.rowOf,
    );

    const input = templateInput(state, made.buildingOf, ' Outside in ', 30);

    expect(input).toEqual({
      name: 'Outside in',
      minutesPerProperty: 30,
      groups: [{ name: 'North', color: '#e6194b', target: 9, buildingIds: ['b3', 'b1'] }],
    });
    const reopened = stateFromTemplate({ groups: input.groups.map((group, index) => ({ ...group, position: index + 1 })) }, made.rowOf);
    expect(sameTemplate(templateInput(reopened.state, made.buildingOf, 'Outside in', 30), input)).toBe(true);
  });

  it('knows an unsaved change from a saved one, whatever the revision', () => {
    const base = { name: 'A', minutesPerProperty: 30, groups: [{ name: 'G', color: '#e6194b', target: 9, buildingIds: ['b1'] }] };

    expect(sameTemplate(base, { ...base, revision: 4 })).toBe(true);
    expect(sameTemplate(base, { ...base, groups: [{ ...base.groups[0]!, buildingIds: ['b1', 'b2'] }] })).toBe(false);
    expect(sameTemplate(base, { ...base, name: 'B' })).toBe(false);
  });

  it('never saves a target a day could not be routed with', () => {
    const input = templateInput({ groups: [{ id: 'g', name: 'Big', color: '#e6194b', target: 40, stops: [2] }] }, made.buildingOf, 'A', 30);

    expect(input.groups[0]!.target).toBe(24);
  });
});

describe('starting from a groups file', () => {
  const made = makerProperties([property('b1'), property('b2'), property('b3')]);
  const file = readGroupFile(
    [
      'group,stop,address,zip,latitude,longitude',
      '1,1,1 First St,77009,29.8,-95.4',
      '1,2,2 Second St,77009,29.81,-95.41',
      '1,3,2 Second St,77009,29.81,-95.41',
      '2,1,3 Third St,77009,29.82,-95.42',
      '2,2,4 Fourth St,77009,29.83,-95.43',
    ].join('\n'),
  );

  it('sends each grouped row’s address and postcode, in group order', () => {
    expect(rowsToMatch(file)).toEqual([
      { address: '1 First St', postalCode: '77009' },
      { address: '2 Second St', postalCode: '77009' },
      { address: '2 Second St', postalCode: '77009' },
      { address: '3 Third St', postalCode: '77009' },
      { address: '4 Fourth St', postalCode: '77009' },
    ]);
  });

  it('places each row at the property its address matched, and counts what it could not', () => {
    const result = stateFromMatchedFile(
      file,
      [
        { buildingId: 'b1', outcome: 'MATCHED' },
        { buildingId: 'b2', outcome: 'MATCHED' },
        // Another unit of the same building: one property here.
        { buildingId: 'b2', outcome: 'MATCHED' },
        { buildingId: null, outcome: 'AMBIGUOUS' },
        { buildingId: null, outcome: 'NONE' },
      ],
      made.rowOf,
    );

    expect(result.state.groups.map((group) => group.stops)).toEqual([[2, 3], []]);
    expect(result).toMatchObject({ matched: 2, repeated: 1, ambiguous: 1, unmatched: 1 });
  });
});
