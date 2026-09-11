import { describe, expect, it } from 'vitest';

import {
  ARRIVAL_RADIUS_M,
  ASSUMED_VISIT_SECONDS,
  dayTotals,
  driveToPlace,
  MIN_VISIT_MS,
  placeOf,
  projectRemainder,
  secondsAtPlace,
  segmentDay,
  type TimelineFix,
  type TimelinePlace,
} from '../src/contracts/technician-timeline.js';

/**
 * Reading a day off a location trail.
 *
 * The planner counts stops, not minutes: a fifteen-minute occupied visit and a
 * ninety-minute move-out each cost one of a technician's daily slots. Measuring
 * what a visit actually takes is the prerequisite for planning in time, and
 * every number here ends up somewhere a person makes a decision — so the cases
 * that matter are the ones where the trail is ambiguous, not the ones where
 * somebody drove neatly from A to B.
 */

const DAY = '2026-09-12T';
const at = (hhmm: string) => `${DAY}${hhmm}:00.000Z`;

/** Two houses roughly 900 m apart in Houston, and a road between them. */
const HOUSE_A: TimelinePlace = { id: 'a', latitude: 29.7604, longitude: -95.3698 };
const HOUSE_B: TimelinePlace = { id: 'b', latitude: 29.7684, longitude: -95.3698 };
const ROAD = { latitude: 29.7644, longitude: -95.3698 };

const fix = (place: { latitude: number; longitude: number }, hhmm: string): TimelineFix => ({
  latitude: place.latitude,
  longitude: place.longitude,
  recordedAt: at(hhmm),
});

describe('which place a fix belongs to', () => {
  it('is the place it is standing on', () => {
    expect(placeOf(HOUSE_A, [HOUSE_A, HOUSE_B])).toBe('a');
  });

  it('is nothing out on the road between them', () => {
    expect(placeOf(ROAD, [HOUSE_A, HOUSE_B])).toBeNull();
  });

  it('resolves an overlap to the nearer place rather than to both', () => {
    /**
     * Two stops on the same street can both fall inside the arrival radius.
     * Answering "both" would split one visit across two properties and
     * double-count the time; the nearer one keeps the visit whole.
     */
    const close: TimelinePlace = { id: 'next-door', latitude: 29.76045, longitude: -95.3698 };
    expect(placeOf(HOUSE_A, [close, HOUSE_A])).toBe('a');
  });

  it('has no places to match against without falling over', () => {
    expect(placeOf(HOUSE_A, [])).toBeNull();
  });
});

describe('segmenting an ordinary day', () => {
  const segments = segmentDay(
    [
      fix(HOUSE_A, '09:00'),
      fix(HOUSE_A, '09:20'),
      fix(HOUSE_A, '09:40'),
      fix(ROAD, '09:50'),
      fix(HOUSE_B, '10:00'),
      fix(HOUSE_B, '10:30'),
    ],
    [HOUSE_A, HOUSE_B],
  );

  it('reads as visit, drive, visit', () => {
    expect(segments.map((segment) => [segment.kind, segment.placeId])).toEqual([
      ['AT_PLACE', 'a'],
      ['TRAVELLING', null],
      ['AT_PLACE', 'b'],
    ]);
  });

  it('starts the drive when they left, not when they reached the road', () => {
    /**
     * The drive away from a property begins at its last fix there. Starting it
     * at the first fix out on the road would silently lose the minutes spent
     * walking to the van from every journey of every day.
     */
    const drive = segments[1];
    expect(drive.startedAt).toBe(at('09:40'));
    expect(drive.seconds).toBe(20 * 60);
  });

  it('leaves no unaccounted gap between segments', () => {
    for (let index = 1; index < segments.length; index += 1)
      expect(segments[index].startedAt).toBe(segments[index - 1].endedAt);
  });
});

describe('the trail going quiet', () => {
  it('keeps a silence inside a property as part of the visit', () => {
    /**
     * The most ordinary thing in this data. A handset indoors stops reporting
     * for most of an hour and the inspection carries on — without this, a long
     * visit reads as two short ones with a hole between them, and the average
     * visit length collapses.
     */
    const segments = segmentDay(
      [fix(HOUSE_A, '09:00'), fix(HOUSE_A, '10:00'), fix(ROAD, '10:10')],
      [HOUSE_A],
    );
    const visits = segments.filter((segment) => segment.kind === 'AT_PLACE');
    expect(visits).toHaveLength(1);
    // 09:00 to the last fix there. The ten minutes before they appear on the
    // road belong to the drive away, not to the visit -- see below.
    expect(visits[0].seconds).toBe(60 * 60);
  });

  it('gives the minutes between the last fix here and the first fix there to the drive', () => {
    /**
     * A real choice, worth pinning down. Somebody last seen at the property at
     * 10:00 and first seen on the road at 10:10 left at some unknowable moment
     * in between, and those ten minutes have to go somewhere.
     *
     * They go to the drive. Walking out, locking up and getting into the van is
     * travel, not inspecting -- and the alternative biases the one number this
     * is built to produce, average visit length, upwards on every visit of
     * every day.
     */
    const segments = segmentDay(
      [fix(HOUSE_A, '09:00'), fix(HOUSE_A, '10:00'), fix(ROAD, '10:10')],
      [HOUSE_A],
    );
    const drive = segments.find((segment) => segment.kind === 'TRAVELLING');
    expect(drive?.startedAt).toBe(at('10:00'));
    expect(drive?.seconds).toBe(10 * 60);

    // And nothing is lost: the parts still add to the whole.
    const totals = dayTotals(segments);
    expect(totals.onSiteSeconds + totals.travellingSeconds).toBe(totals.shiftSeconds);
  });

  it('does not invent one continuous drive across an untrusted silence', () => {
    // Out on the road there is nothing supporting a claim either way, so a long
    // gap starts a fresh run rather than asserting an hour of driving.
    const segments = segmentDay(
      [fix(ROAD, '09:00'), fix(ROAD, '09:05'), fix(ROAD, '11:00'), fix(ROAD, '11:05')],
      [HOUSE_A],
    );
    expect(segments.length).toBeGreaterThan(1);
  });
});

describe('driving past the next stop', () => {
  it('is not a visit', () => {
    /**
     * A route frequently passes a later stop on the way to an earlier one.
     * Counting each pass as a visit inflates the visit count and deflates the
     * average length — the exact number this exists to produce.
     */
    const segments = segmentDay(
      [
        fix(ROAD, '09:00'),
        fix(HOUSE_B, '09:02'),
        fix(ROAD, '09:04'),
        fix(HOUSE_A, '09:20'),
        fix(HOUSE_A, '10:00'),
      ],
      [HOUSE_A, HOUSE_B],
    );
    expect(segments.some((segment) => segment.placeId === 'b')).toBe(false);
  });

  it('keeps the time rather than deleting it', () => {
    // Dropping the pass would leave the drives either side failing to meet, and
    // the shift would lose minutes nobody could account for.
    const fixes = [
      fix(ROAD, '09:00'),
      fix(HOUSE_B, '09:02'),
      fix(ROAD, '09:04'),
      fix(HOUSE_A, '09:20'),
      fix(HOUSE_A, '10:00'),
    ];
    const segments = segmentDay(fixes, [HOUSE_A, HOUSE_B]);
    const totals = dayTotals(segments);
    expect(totals.shiftSeconds).toBe(60 * 60);
    expect(totals.onSiteSeconds + totals.travellingSeconds).toBe(60 * 60);
  });

  it('merges the drives either side into one', () => {
    const segments = segmentDay(
      [fix(ROAD, '09:00'), fix(HOUSE_B, '09:02'), fix(ROAD, '09:04'), fix(HOUSE_A, '09:20')],
      [HOUSE_A, HOUSE_B],
    );
    expect(segments.filter((segment) => segment.kind === 'TRAVELLING')).toHaveLength(1);
  });

  it('counts a stay that just clears the floor', () => {
    const start = 9 * 60;
    const end = start + MIN_VISIT_MS / 60_000;
    const hhmm = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const segments = segmentDay(
      [fix(ROAD, hhmm(start - 5)), fix(HOUSE_A, hhmm(start)), fix(HOUSE_A, hhmm(end))],
      [HOUSE_A],
    );
    expect(segments.some((segment) => segment.placeId === 'a')).toBe(true);
  });
});

describe('fixes arriving out of order', () => {
  it('is read in the order they were taken, not the order they landed', () => {
    /**
     * A handset back from a dead zone flushes its queue after live fixes have
     * already arrived. Folding in arrival order interleaves an hour-old
     * position into the present and cuts the current visit in half.
     */
    const inOrder = segmentDay(
      [fix(HOUSE_A, '09:00'), fix(HOUSE_A, '09:30'), fix(HOUSE_A, '10:00')],
      [HOUSE_A],
    );
    const shuffled = segmentDay(
      [fix(HOUSE_A, '10:00'), fix(HOUSE_A, '09:00'), fix(HOUSE_A, '09:30')],
      [HOUSE_A],
    );
    expect(shuffled).toEqual(inOrder);
  });

  it('ignores a fix whose timestamp cannot be read', () => {
    const segments = segmentDay(
      [
        fix(HOUSE_A, '09:00'),
        { latitude: HOUSE_A.latitude, longitude: HOUSE_A.longitude, recordedAt: 'not a date' },
        fix(HOUSE_A, '10:00'),
      ],
      [HOUSE_A],
    );
    expect(dayTotals(segments).shiftSeconds).toBe(60 * 60);
  });
});

describe('a day that is barely there', () => {
  it.each([[[]], [[fix(HOUSE_A, '09:00')]]])('says nothing about %# fix(es)', (fixes) => {
    // One fix is a position, not a duration. Reporting a zero-length visit
    // would put a technician on a roster having spent no time anywhere.
    expect(segmentDay(fixes as TimelineFix[], [HOUSE_A])).toEqual([]);
  });

  it('totals an empty day to zero rather than to NaN', () => {
    expect(dayTotals([])).toEqual({
      onSiteSeconds: 0,
      travellingSeconds: 0,
      shiftSeconds: 0,
      visits: 0,
    });
  });
});

describe('what the day came to', () => {
  const segments = segmentDay(
    [
      fix(HOUSE_A, '09:00'),
      fix(HOUSE_A, '09:40'),
      fix(ROAD, '09:50'),
      fix(HOUSE_B, '10:00'),
      fix(HOUSE_B, '11:00'),
    ],
    [HOUSE_A, HOUSE_B],
  );

  it('measures the shift end to end', () => {
    expect(dayTotals(segments).shiftSeconds).toBe(2 * 60 * 60);
  });

  it('counts the visits', () => {
    expect(dayTotals(segments).visits).toBe(2);
  });

  it('sums every separate stay at one place', () => {
    /**
     * A technician who goes back to the van for a ladder and returns has made
     * one visit in two parts, and the time it took is both of them.
     */
    const there = segmentDay(
      [
        fix(HOUSE_A, '09:00'),
        fix(HOUSE_A, '09:30'),
        fix(ROAD, '09:40'),
        fix(HOUSE_A, '09:50'),
        fix(HOUSE_A, '10:20'),
      ],
      [HOUSE_A],
    );
    // 30 minutes before the errand and 30 after. The 20 in between is the
    // round trip to the van, which is travel.
    expect(secondsAtPlace(there, 'a')).toBe(60 * 60);
  });

  it('reports the drive that reached a stop', () => {
    expect(driveToPlace(segments, 'b')).toBe(20 * 60);
  });

  it('has no drive to report for the first stop of the day', () => {
    // Not missing data: the journey from home is only a fact once we know they
    // set off from home, which is a different question.
    expect(driveToPlace(segments, 'a')).toBeNull();
  });

  it('has nothing to say about a place they never reached', () => {
    expect(secondsAtPlace(segments, 'never-visited')).toBe(0);
    expect(driveToPlace(segments, 'never-visited')).toBeNull();
  });
});

describe('the arrival radius', () => {
  it('reaches the kerb and the driveway', () => {
    // Roughly 60 m north of the house: still the same visit.
    const kerb = { latitude: HOUSE_A.latitude + 0.00054, longitude: HOUSE_A.longitude };
    expect(placeOf(kerb, [HOUSE_A])).toBe('a');
  });

  it('does not reach the next street', () => {
    const away = { latitude: HOUSE_A.latitude + 0.003, longitude: HOUSE_A.longitude };
    expect(placeOf(away, [HOUSE_A])).toBeNull();
  });

  it('can be narrowed where the pins are known to be good', () => {
    // Rooftop geocoding makes a tighter radius defensible; interpolated pins
    // are on the road outside and need the slack.
    const kerb = { latitude: HOUSE_A.latitude + 0.00054, longitude: HOUSE_A.longitude };
    expect(placeOf(kerb, [HOUSE_A], 25)).toBeNull();
    expect(ARRIVAL_RADIUS_M).toBeGreaterThan(25);
  });
});

describe('projecting what is left of the day', () => {
  /**
   * Not a comparison against a scheduled time, because there is no scheduled
   * time. `scheduledStartAt` and `scheduledEndAt` exist on `Inspection` and
   * were set on **0 of the 189 inspections** scheduled in the previous thirty
   * days. A detector built on them would have compared against null on every
   * row and reported everybody on time for ever — worse than nothing, because
   * it looks like an answer.
   */
  const NOW = Date.parse(at('14:00'));

  const dayWithTwoDoneVisits = segmentDay(
    [
      fix(HOUSE_A, '09:00'),
      fix(HOUSE_A, '10:00'),
      fix(ROAD, '10:20'),
      fix(HOUSE_B, '10:40'),
      fix(HOUSE_B, '11:40'),
    ],
    [HOUSE_A, HOUSE_B],
  );

  it("uses this technician's own measured visits when it has them", () => {
    const projection = projectRemainder(
      dayWithTwoDoneVisits,
      [{ driveSeconds: 600 }, { driveSeconds: 900 }],
      { now: NOW },
    );

    expect(projection.basis).toBe('MEASURED');
    // Two visits of an hour each.
    expect(projection.perVisitSeconds).toBe(60 * 60);
    // Two more hours of visits plus twenty-five minutes of driving.
    expect(projection.remainingSeconds).toBe(2 * 3600 + 600 + 900);
    expect(projection.projectedFinishAt).toBe(at('16:25'));
  });

  it('says so when it is guessing', () => {
    // Nothing finished yet, so there is nothing to measure. The number is a
    // placeholder and the caller is told, rather than being handed a figure
    // that looks derived.
    const justArrived = segmentDay(
      [fix(ROAD, '09:00'), fix(HOUSE_A, '09:30'), fix(HOUSE_A, '09:50')],
      [HOUSE_A],
    );
    const projection = projectRemainder(justArrived, [{ driveSeconds: 600 }], { now: NOW });

    expect(projection.basis).toBe('ESTIMATED');
    expect(projection.perVisitSeconds).toBe(ASSUMED_VISIT_SECONDS);
  });

  it('does not let the visit in progress drag the average down', () => {
    /**
     * The failure this is written against. A technician five minutes into their
     * third visit has not made a five-minute visit — but a naive average counts
     * it as one, halves the expected visit length, and reports a finish two
     * hours earlier than reality. Optimistic exactly when somebody is already
     * behind.
     */
    const midVisit = segmentDay(
      [
        fix(HOUSE_A, '09:00'),
        fix(HOUSE_A, '10:00'),
        fix(ROAD, '10:20'),
        fix(HOUSE_B, '10:40'),
        fix(HOUSE_B, '10:45'),
      ],
      [HOUSE_A, HOUSE_B],
    );

    const projection = projectRemainder(midVisit, [{ driveSeconds: 0 }], { now: NOW });

    // The finished visit was an hour; the five-minute one in progress is not
    // evidence about how long a visit takes.
    expect(projection.perVisitSeconds).toBe(60 * 60);
  });

  it('has nothing left to project when the day is done', () => {
    const projection = projectRemainder(dayWithTwoDoneVisits, [], { now: NOW });

    expect(projection.stopsRemaining).toBe(0);
    expect(projection.remainingSeconds).toBe(0);
    expect(projection.projectedFinishAt).toBe(at('14:00'));
  });

  it('still counts a stop whose drive could not be routed', () => {
    // A property that never geocoded still has to be driven to. Treating the
    // journey as instantaneous would quietly shorten the day.
    const projection = projectRemainder(dayWithTwoDoneVisits, [{ driveSeconds: null }], {
      now: NOW,
    });

    expect(projection.remainingSeconds).toBeGreaterThan(projection.perVisitSeconds);
  });
});
