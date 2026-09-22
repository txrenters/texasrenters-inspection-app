import type { NavManeuver, NavigationStep } from '@texasrenters/shared';

import { formatDistance } from './format';

/**
 * The sentence an announcement says, and nothing else.
 *
 * ## There is no voice in this build, and that is not an oversight
 *
 * Speaking needs `expo-speech`, which is a native module. `app.config.ts`
 * carries version `1.2.0` and the update policy is `appVersion`, so that string
 * *is* the runtime version: an `eas update` that imports a module the installed
 * binary does not contain does not degrade, it throws on import and the app is
 * dead on launch for every technician on that build. So this module decides the
 * words and hands them back; the OTA build shows announcements on screen, and
 * the voice arrives with the next native build by passing a `speak` callback
 * into `announce`. Nothing else has to change when it does.
 *
 * ## Why the sentence is built here rather than taken from the router
 *
 * Google's `navigationInstruction.instructions` is already a sentence -- "Turn
 * right onto Westheimer Rd" -- but it carries no distance, and a banner that
 * says the same eleven words at a mile out and at the junction tells the driver
 * nothing about which one is happening now. The distance is the whole point of
 * an announcement. The router's own words are still used verbatim wherever the
 * maneuver enum is `CONTINUE`, which is what `maneuverFromGoogle` returns for
 * anything it does not recognise: the enum can be wrong, the instruction string
 * never is.
 */

/** What speaking would do, once a native build can. Null in this one. */
export type NavSpeaker = (sentence: string) => void;

/** One announcement, decided. */
export interface NavAnnouncement {
  /**
   * Which of `NAV_ANNOUNCE_DISTANCES_M` fired it. Carried so the caller can
   * record what has already been said for this step without re-deriving it.
   */
  thresholdMeters: number;
  /** The step being announced. */
  stepIndex: number;
  /** What to show, and one day to say. */
  sentence: string;
}

/**
 * Close enough that the distance is not worth saying.
 *
 * At 60 m the driver is at the junction. "In two hundred feet, turn right" read
 * out while they are turning is worse than "Turn right" -- it invites them to
 * wait for a turn they are already at.
 */
const IMMEDIATE_M = 100;

/**
 * The distances a driver hears as a phrase rather than as a number.
 *
 * "In one mile" and "In a quarter of a mile" are what a person says. "In 1.0 mi"
 * is what a machine says, and read aloud it is "in one point oh miles".
 * Thresholds not listed here fall back to `formatDistance`, which is correct if
 * a little stiff, so adding a threshold to `NAV_ANNOUNCE_DISTANCES_M` never
 * produces a sentence with a gap in it.
 */
const DISTANCE_PHRASES: Readonly<Record<number, string>> = {
  3_200: 'In two miles',
  1_600: 'In one mile',
  800: 'In half a mile',
  400: 'In a quarter of a mile',
};

const MANEUVER_CLAUSES: Readonly<Record<NavManeuver, string>> = {
  DEPART: 'set off',
  CONTINUE: 'continue',
  TURN_SLIGHT_LEFT: 'bear left',
  TURN_LEFT: 'turn left',
  TURN_SHARP_LEFT: 'take the sharp left',
  TURN_SLIGHT_RIGHT: 'bear right',
  TURN_RIGHT: 'turn right',
  TURN_SHARP_RIGHT: 'take the sharp right',
  UTURN_LEFT: 'make a U-turn',
  UTURN_RIGHT: 'make a U-turn',
  RAMP_LEFT: 'take the ramp on the left',
  RAMP_RIGHT: 'take the ramp on the right',
  MERGE: 'merge',
  FORK_LEFT: 'keep left at the fork',
  FORK_RIGHT: 'keep right at the fork',
  ROUNDABOUT_LEFT: 'take the roundabout',
  ROUNDABOUT_RIGHT: 'take the roundabout',
  FERRY: 'take the ferry',
  ARRIVE: 'you arrive',
};

/** How each maneuver joins the road it names. "merge onto", but "continue on". */
function preposition(maneuver: NavManeuver): string {
  if (maneuver === 'CONTINUE' || maneuver === 'DEPART') return 'on';
  if (maneuver === 'ARRIVE') return 'at';
  return 'onto';
}

/**
 * The instruction half of the sentence, without any distance.
 *
 * `destination` names the property for the arrival step, because "you arrive"
 * on its own is the one instruction where the road name is not what the driver
 * wants -- they want to know they are at the Tanglewood job and not the one
 * before it.
 */
export function maneuverClause(step: NavigationStep, destination?: string | null): string {
  if (step.maneuver === 'ARRIVE') {
    return destination ? `you arrive at ${destination}` : 'you arrive at your destination';
  }

  // The enum said nothing useful, so the router's own words are all we have --
  // and they are always right. See `maneuverFromGoogle`.
  if (step.maneuver === 'CONTINUE' && step.instruction.trim()) {
    return lowerFirst(step.instruction.trim());
  }

  const clause = MANEUVER_CLAUSES[step.maneuver];
  if (!step.roadName?.trim()) return clause;
  return `${clause} ${preposition(step.maneuver)} ${step.roadName.trim()}`;
}

/** "In a quarter of a mile, turn right onto Westheimer Road" */
export function announcementSentence(
  step: NavigationStep,
  thresholdMeters: number,
  destination?: string | null,
): string {
  const clause = maneuverClause(step, destination);
  if (thresholdMeters <= IMMEDIATE_M) return upperFirst(clause);

  const phrase = DISTANCE_PHRASES[thresholdMeters] ?? `In ${formatDistance(thresholdMeters)}`;
  return `${phrase}, ${clause}`;
}

/**
 * Hands an announcement to the voice, when there is one.
 *
 * Deliberately tolerant of a speaker that throws: a failed utterance must never
 * take down the screen the driver is steering by. The banner has already shown
 * the same words.
 */
export function announce(announcement: NavAnnouncement, speak: NavSpeaker | null): void {
  if (!speak) return;
  try {
    speak(announcement.sentence);
  } catch {
    // Silent on purpose. See above.
  }
}

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Lower-cases only a leading capital that is there because it began a sentence.
 *
 * "Turn right onto Westheimer" becomes "turn right onto Westheimer" so it can
 * follow "In one mile,". An instruction that begins with a proper noun -- "US-59
 * North" -- keeps its capital, because the second character being upper case
 * says this is a name rather than a sentence start.
 */
function lowerFirst(value: string): string {
  const second = value.charAt(1);
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}
