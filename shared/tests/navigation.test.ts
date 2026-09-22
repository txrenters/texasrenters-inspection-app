import { describe, expect, it } from 'vitest';

import {
  maneuverFromGoogle,
  maneuverFromOsrm,
  maneuverSide,
  NAV_ANNOUNCE_DISTANCES_M,
  NAV_ARRIVAL_DWELL_MS,
  NAV_ARRIVAL_RADIUS_M,
  NAV_ARRIVAL_SPEED_MS,
  NAV_MANEUVERS,
  NAV_MAX_ACCURACY_M,
  NAV_MOVING_SPEED_MS,
  NAV_OFF_ROUTE_FIXES,
  NAV_OFF_ROUTE_M,
  NAV_STEP_ADVANCE_M,
  type NavManeuver,
} from '../src/contracts/navigation.js';

/**
 * Two routers' vocabularies, flattened onto one the phone has icons for.
 *
 * The mapping functions look trivial and are not: each one has a case where the
 * obvious reading is wrong in production. Google leaves `maneuver` unset on the
 * last step of every leg, so a naive mapping makes the single most important
 * instruction of a drive -- "you are here" -- the one that renders as unknown.
 * OSRM splits the same information across two fields that only mean anything
 * read together. Both are pinned here so that a later tidy-up of either table
 * cannot quietly reintroduce those faults.
 */

describe('Google maneuvers', () => {
  it('maps the enum members that have their own arrow', () => {
    expect(maneuverFromGoogle('TURN_LEFT', false)).toBe('TURN_LEFT');
    expect(maneuverFromGoogle('TURN_SHARP_RIGHT', false)).toBe('TURN_SHARP_RIGHT');
    expect(maneuverFromGoogle('ROUNDABOUT_LEFT', false)).toBe('ROUNDABOUT_LEFT');
    expect(maneuverFromGoogle('UTURN_RIGHT', false)).toBe('UTURN_RIGHT');
    expect(maneuverFromGoogle('DEPART', false)).toBe('DEPART');
  });

  it('folds the members that draw a straight arrow onto CONTINUE', () => {
    // Nothing is lost: the step's own instruction text is what is read out, and
    // "Continue on Westheimer Rd" is exactly what a NAME_CHANGE step says.
    expect(maneuverFromGoogle('STRAIGHT', false)).toBe('CONTINUE');
    expect(maneuverFromGoogle('NAME_CHANGE', false)).toBe('CONTINUE');
  });

  it('folds both ferry members onto one, because one icon covers both', () => {
    expect(maneuverFromGoogle('FERRY', false)).toBe('FERRY');
    expect(maneuverFromGoogle('FERRY_TRAIN', false)).toBe('FERRY');
  });

  it('always yields ARRIVE on the last step, whatever the router said', () => {
    // isLast wins outright. Google has no arrival member, so the last step of a
    // leg legitimately carries a real maneuver -- the final turn into the street
    // is a TURN_RIGHT whose instruction reads "Destination will be on the
    // right". Honouring the maneuver there would leave the drive with no
    // arrival at all and no chequered flag on the banner.
    expect(maneuverFromGoogle('TURN_RIGHT', true)).toBe('ARRIVE');
    expect(maneuverFromGoogle('ROUNDABOUT_LEFT', true)).toBe('ARRIVE');
    expect(maneuverFromGoogle('DEPART', true)).toBe('ARRIVE');
  });

  it('yields ARRIVE on a last step that carries no maneuver at all', () => {
    // The common case: Google simply omits the field on the final step.
    expect(maneuverFromGoogle(undefined, true)).toBe('ARRIVE');
    expect(maneuverFromGoogle(null, true)).toBe('ARRIVE');
  });

  it('reads an unknown or absent maneuver as CONTINUE rather than throwing', () => {
    // Google adds enum members without warning. A new one must draw a straight
    // arrow beside correct instruction text, not crash the banner mid-drive.
    expect(maneuverFromGoogle('SOME_NEW_MANEUVER_2027', false)).toBe('CONTINUE');
    expect(maneuverFromGoogle(undefined, false)).toBe('CONTINUE');
    expect(maneuverFromGoogle(null, false)).toBe('CONTINUE');
    expect(maneuverFromGoogle(42, false)).toBe('CONTINUE');
    expect(maneuverFromGoogle({ maneuver: 'TURN_LEFT' }, false)).toBe('CONTINUE');
  });

  it('never invents a maneuver outside the drawable set', () => {
    const samples: unknown[] = [
      'TURN_LEFT',
      'FERRY_TRAIN',
      'NAME_CHANGE',
      'GARBAGE',
      undefined,
      7,
    ];
    for (const sample of samples) {
      expect(NAV_MANEUVERS).toContain(maneuverFromGoogle(sample, false));
      expect(NAV_MANEUVERS).toContain(maneuverFromGoogle(sample, true));
    }
  });
});

describe('OSRM maneuvers', () => {
  it('reads type and modifier together', () => {
    // The whole reason this function exists: neither field means anything
    // alone. 'turn' with no modifier is not a turn, and 'slight left' with no
    // type could be a fork, a ramp or a roundabout exit.
    expect(maneuverFromOsrm('turn', 'slight left')).toBe('TURN_SLIGHT_LEFT');
    expect(maneuverFromOsrm('turn', 'left')).toBe('TURN_LEFT');
    expect(maneuverFromOsrm('turn', 'sharp left')).toBe('TURN_SHARP_LEFT');
    expect(maneuverFromOsrm('turn', 'slight right')).toBe('TURN_SLIGHT_RIGHT');
    expect(maneuverFromOsrm('turn', 'right')).toBe('TURN_RIGHT');
    expect(maneuverFromOsrm('turn', 'sharp right')).toBe('TURN_SHARP_RIGHT');
  });

  it('treats a straight "turn" as CONTINUE, not as TURN_STRAIGHT', () => {
    // TURN_STRAIGHT is not a member. Building the name by concatenation would
    // produce one that no icon table has an entry for.
    expect(maneuverFromOsrm('turn', 'straight')).toBe('CONTINUE');
    expect(maneuverFromOsrm('continue', 'straight')).toBe('CONTINUE');
  });

  it('maps arrival and departure before it looks at the modifier', () => {
    // OSRM puts a modifier on the arrival step describing which side of the
    // road the destination is on. Read as a turn that becomes TURN_LEFT, and
    // the drive ends by telling the technician to turn into a garden.
    expect(maneuverFromOsrm('arrive', 'left')).toBe('ARRIVE');
    expect(maneuverFromOsrm('arrive', 'right')).toBe('ARRIVE');
    expect(maneuverFromOsrm('arrive', undefined)).toBe('ARRIVE');
    expect(maneuverFromOsrm('depart', 'straight')).toBe('DEPART');
    expect(maneuverFromOsrm('merge', 'left')).toBe('MERGE');
  });

  it('maps the types that carry a side', () => {
    expect(maneuverFromOsrm('roundabout', 'left')).toBe('ROUNDABOUT_LEFT');
    expect(maneuverFromOsrm('roundabout', 'right')).toBe('ROUNDABOUT_RIGHT');
    expect(maneuverFromOsrm('rotary', 'left')).toBe('ROUNDABOUT_LEFT');
    expect(maneuverFromOsrm('fork', 'slight left')).toBe('FORK_LEFT');
    expect(maneuverFromOsrm('fork', 'slight right')).toBe('FORK_RIGHT');
    expect(maneuverFromOsrm('on ramp', 'right')).toBe('RAMP_RIGHT');
    expect(maneuverFromOsrm('off ramp', 'left')).toBe('RAMP_LEFT');
    expect(maneuverFromOsrm('end of road', 'left')).toBe('TURN_LEFT');
  });

  it('reads a u-turn from the modifier, whatever the type says', () => {
    // 'uturn' does not end in LEFT or RIGHT, so it has no side. Texas drives on
    // the right, so a u-turn is a left unless told otherwise.
    expect(maneuverFromOsrm('turn', 'uturn')).toBe('UTURN_LEFT');
    expect(maneuverFromOsrm('continue', 'uturn')).toBe('UTURN_LEFT');
  });

  it('falls back to CONTINUE for junk in either field', () => {
    expect(maneuverFromOsrm('flywheel', 'left')).toBe('CONTINUE');
    expect(maneuverFromOsrm('new name', 'right')).toBe('CONTINUE');
    expect(maneuverFromOsrm(undefined, 'left')).toBe('CONTINUE');
    expect(maneuverFromOsrm(null, null)).toBe('CONTINUE');
    expect(maneuverFromOsrm(42, 'left')).toBe('CONTINUE');
    expect(maneuverFromOsrm('turn', 42)).toBe('CONTINUE');
    expect(maneuverFromOsrm('turn', undefined)).toBe('CONTINUE');
  });

  it('never invents a maneuver outside the drawable set', () => {
    const types: unknown[] = ['turn', 'fork', 'roundabout', 'on ramp', 'arrive', 'junk', 9, null];
    const modifiers: unknown[] = ['left', 'slight right', 'uturn', 'straight', 'junk', undefined];
    for (const type of types) {
      for (const modifier of modifiers) {
        expect(NAV_MANEUVERS).toContain(maneuverFromOsrm(type, modifier));
      }
    }
  });
});

describe('which way an arrow points', () => {
  it('reads the side off the maneuver name', () => {
    expect(maneuverSide('TURN_SLIGHT_LEFT')).toBe('LEFT');
    expect(maneuverSide('ROUNDABOUT_RIGHT')).toBe('RIGHT');
    expect(maneuverSide('RAMP_LEFT')).toBe('LEFT');
    expect(maneuverSide('UTURN_RIGHT')).toBe('RIGHT');
  });

  it('has no side for the maneuvers that are not a turn', () => {
    expect(maneuverSide('DEPART')).toBeNull();
    expect(maneuverSide('CONTINUE')).toBeNull();
    expect(maneuverSide('MERGE')).toBeNull();
    expect(maneuverSide('FERRY')).toBeNull();
    expect(maneuverSide('ARRIVE')).toBeNull();
  });

  it('answers for every member, so an icon table can be exhaustive', () => {
    for (const maneuver of NAV_MANEUVERS) {
      expect(['LEFT', 'RIGHT', null]).toContain(maneuverSide(maneuver));
    }
  });
});

describe('the list of maneuvers', () => {
  it('has no duplicates', () => {
    expect(new Set(NAV_MANEUVERS).size).toBe(NAV_MANEUVERS.length);
  });

  it('contains every member the mapping tables can produce', () => {
    // A member added to the type and to a mapping table but forgotten here
    // would compile, map correctly, and render with no icon.
    const produced: NavManeuver[] = [
      maneuverFromGoogle('DEPART', false),
      maneuverFromGoogle('FERRY_TRAIN', false),
      maneuverFromGoogle(undefined, true),
      maneuverFromOsrm('turn', 'sharp left'),
      maneuverFromOsrm('fork', 'right'),
      maneuverFromOsrm('on ramp', 'left'),
      maneuverFromOsrm('merge', 'straight'),
      maneuverFromOsrm('roundabout', 'left'),
      maneuverFromOsrm('turn', 'uturn'),
    ];
    for (const maneuver of produced) expect(NAV_MANEUVERS).toContain(maneuver);
  });
});

describe('the thresholds navigation is judged by', () => {
  it('arrives on radius and speed together, not either alone', () => {
    // Residential stops sit about 40 m apart. A 100 m radius alone -- what
    // technician-timeline.ts uses, correctly, for a question asked after the
    // fact -- would advance the chain while driving past the next house.
    expect(NAV_ARRIVAL_RADIUS_M).toBe(60);
    expect(NAV_ARRIVAL_SPEED_MS).toBe(2.5);
    // A brisk walk, so a vehicle turning into a driveway is under it and a
    // vehicle passing at any road speed is not.
    expect(NAV_ARRIVAL_SPEED_MS).toBeLessThan(5);
    expect(NAV_ARRIVAL_DWELL_MS).toBe(6_000);
  });

  it('holds a navigator to a tighter line than the console', () => {
    // The console's OFF_ROUTE_M is 150 m and answers a different question. A
    // navigator has to notice a wrong turn inside a block, and 50 m still
    // clears urban wander and a divided carriageway.
    expect(NAV_OFF_ROUTE_M).toBe(50);
    expect(NAV_OFF_ROUTE_FIXES).toBe(3);
    // The step margin must stay well under the off-route distance, or a fix
    // could advance the step and leave the route on the same reading.
    expect(NAV_STEP_ADVANCE_M).toBe(25);
    expect(NAV_STEP_ADVANCE_M).toBeLessThan(NAV_OFF_ROUTE_M);
  });

  it('refuses fixes the office map would happily draw', () => {
    // MAX_USEFUL_ACCURACY_M in technician-location.ts is 500 m, which is right
    // for a dot on a map and useless for choosing a street.
    expect(NAV_MAX_ACCURACY_M).toBe(50);
    expect(NAV_MAX_ACCURACY_M).toBeLessThan(500);
    expect(NAV_MOVING_SPEED_MS).toBe(0.5);
  });

  it('announces from far to near, and the last one sits inside the arrival radius', () => {
    expect(NAV_ANNOUNCE_DISTANCES_M).toEqual([1_600, 400, 60]);
    const descending = [...NAV_ANNOUNCE_DISTANCES_M].sort((a, b) => b - a);
    expect([...NAV_ANNOUNCE_DISTANCES_M]).toEqual(descending);
    // The final announcement is "turn now", so it has to be at the maneuver
    // rather than before it.
    expect(NAV_ANNOUNCE_DISTANCES_M[NAV_ANNOUNCE_DISTANCES_M.length - 1]).toBeLessThanOrEqual(
      NAV_ARRIVAL_RADIUS_M,
    );
  });
});
