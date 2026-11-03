import { describe, expect, it } from 'vitest';

import {
  stopKind,
  technicianDay,
  type Timesheet,
  type TimesheetDrive,
  type TimesheetStop,
  type TimesheetVisit,
} from './timesheet-queries';

/**
 * A technician's day as a list (the office, 2026-11-04: "we should be able to
 * determine the drive time, time on the property ... where did they stop,
 * like hardwares, convenient store including the name of the stores").
 */

const DAY = '2026-11-04';
/** Minutes after eight in the morning in Texas, as an instant. */
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 14, minutes)).toISOString();

const visit = (key: string, address: string, from: number, to: number, extra: Partial<TimesheetVisit> = {}) =>
  ({
    key,
    technicianId: 'tech-1',
    technician: 'Pat Lee',
    buildingId: key,
    inspectionId: `insp-${key}`,
    address,
    arrivedAt: at(from),
    leftAt: at(to),
    onsiteSeconds: (to - from) * 60,
    quietSeconds: 0,
    stays: 1,
    segmentIds: [],
    adjusted: false,
    addedByHand: false,
    jobs: [],
    ...extra,
  }) satisfies TimesheetVisit;

const stop = (key: string, from: number, to: number, place: TimesheetStop['place']) =>
  ({
    key,
    technicianId: 'tech-1',
    technician: 'Pat Lee',
    arrivedAt: at(from),
    leftAt: at(to),
    durationSeconds: (to - from) * 60,
    quietSeconds: 0,
    place,
    latitude: null,
    longitude: null,
  }) satisfies TimesheetStop;

const drive = (key: string, from: number, to: number, fromKey: string | null, toKey: string | null) =>
  ({
    key,
    technicianId: 'tech-1',
    technician: 'Pat Lee',
    startedAt: at(from),
    endedAt: at(to),
    durationSeconds: (to - from) * 60,
    quietSeconds: 0,
    fromKey,
    toKey,
  }) satisfies TimesheetDrive;

const STORE = stop('stop-1', 75, 95, {
  kind: 'BUSINESS',
  name: 'The Home Depot',
  address: '1 Supply Rd',
  category: 'shop=doityourself',
});

function sheet(extra: Partial<Timesheet> = {}): Timesheet {
  return {
    date: DAY,
    totals: [],
    visits: [visit('a', '1 Oak St', 0, 60, { stays: 2 }), visit('b', '9 Elm Ct', 110, 140)],
    stops: [STORE],
    drives: [
      drive('d-0', 20, 24, 'a', 'a'),
      drive('d-1', 60, 75, 'a', 'stop-1'),
      drive('d-2', 95, 110, 'stop-1', 'b'),
    ],
    ...extra,
  };
}

describe('a technician’s day, in order', () => {
  it('lists each property, drive and stop as it happened', () => {
    expect(technicianDay(sheet(), 'tech-1').map((entry) => `${entry.kind}:${entry.key}`)).toEqual([
      'visit:a',
      'drive:d-1',
      'stop:stop-1',
      'drive:d-2',
      'visit:b',
    ]);
  });

  it('says where each drive came from and went to', () => {
    const drives = technicianDay(sheet(), 'tech-1').filter((entry) => entry.kind === 'drive');

    expect(drives.map((entry) => [entry.from, entry.to, entry.seconds])).toEqual([
      ['1 Oak St', 'The Home Depot', 15 * 60],
      ['The Home Depot', '9 Elm Ct', 15 * 60],
    ]);
  });

  /** Out to the van and back is general time, but not a drive anywhere. */
  it('folds a step out of a property’s circle into that visit', () => {
    const first = technicianDay(sheet(), 'tech-1')[0]!;

    expect(first).toMatchObject({ kind: 'visit', key: 'a', steppedOutSeconds: 4 * 60 });
  });

  /** The minutes are in the totals for everybody; where, only for some. */
  it('says only "a stop" to somebody who may not see where it was', () => {
    const drives = technicianDay(sheet({ stops: undefined }), 'tech-1').filter((entry) => entry.kind === 'drive');

    expect(drives.map((entry) => [entry.from, entry.to])).toEqual([
      ['1 Oak St', 'a stop'],
      ['a stop', '9 Elm Ct'],
    ]);
  });

  it('says "a stop" for one not named yet, rather than that it is being looked up', () => {
    const waiting = { ...STORE, place: null };
    const drives = technicianDay(sheet({ stops: [waiting] }), 'tech-1').filter((entry) => entry.kind === 'drive');

    expect(drives[0]).toMatchObject({ from: '1 Oak St', to: 'a stop' });
  });

  it('keeps to the one technician asked for', () => {
    const other = { ...visit('c', '5 Pine Pl', 0, 30), technicianId: 'tech-2' };

    expect(technicianDay(sheet({ visits: [other] }), 'tech-2').map((entry) => entry.key)).toEqual(['c']);
  });

  it('reads a sheet from a server that sends no drives', () => {
    expect(technicianDay(sheet({ drives: undefined }), 'tech-1').map((entry) => entry.kind)).toEqual([
      'visit',
      'stop',
      'visit',
    ]);
  });
});

describe('what kind of place a stop was', () => {
  const business = (category: string | null | undefined) =>
    stopKind({ place: { kind: 'BUSINESS', name: 'Somewhere', address: null, category } });

  it('says it in the office’s words', () => {
    expect(business('shop=hardware')).toBe('Hardware store');
    expect(business('shop=doityourself')).toBe('Home improvement store');
    expect(business('shop=convenience')).toBe('Convenience store');
    expect(business('amenity=fuel')).toBe('Gas station');
  });

  it('says a kind it has no words for in its own', () => {
    expect(business('shop=garden_furniture')).toBe('Garden furniture');
  });

  it('says nothing when the kind is not known, or there was none', () => {
    expect(business(null)).toBeNull();
    expect(business(undefined)).toBeNull();
    expect(business('')).toBeNull();
    expect(stopKind({ place: { kind: 'HOME', name: 'Home', address: null, category: 'shop=hardware' } })).toBeNull();
    expect(stopKind({ place: null })).toBeNull();
  });
});
