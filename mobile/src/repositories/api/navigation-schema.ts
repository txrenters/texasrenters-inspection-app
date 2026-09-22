import { z } from 'zod';
import { NAV_MANEUVERS, type NavManeuver } from '@texasrenters/shared';

/**
 * The leg the technician is actually driving, as the handset reads it.
 *
 * The day route in `technician-route-schema.ts` answers "where am I going and
 * in what order". This answers "which way do I turn, and when" -- one leg at a
 * time, fetched when somebody presses start and redrawn when they leave the
 * road.
 *
 * ## The axis, stated once
 *
 * **Every coordinate here is `[latitude, longitude]`**, the same as
 * `NavigationLeg` in `shared/`. Nothing on this side flips: the backend's
 * `toLatLngPath` already did it, once, at the edge. An extra flip does not
 * throw -- it draws a plausible drive in the Indian Ocean while each component
 * looks right on its own -- so the tests assert the *sign* of each number
 * (Texas: latitude ~29 positive, longitude ~-95 negative) and never its index.
 *
 * In its own module, like the day route's schema, so it can be tested without
 * dragging in the whole API repository and a session with it.
 */

/** One point of a drawn line, `[latitude, longitude]`. See the note above. */
const latLngSchema = z.tuple([z.number(), z.number()]);

const KNOWN_MANEUVERS: ReadonlySet<string> = new Set<string>(NAV_MANEUVERS);

/**
 * A maneuver name, with anything unrecognised read as `CONTINUE`.
 *
 * Deliberately **not** `z.enum(NAV_MANEUVERS)`. An enum refuses the value, and
 * a refused field refuses the whole leg -- so a router that starts sending a
 * maneuver name nobody has drawn an icon for yet would leave a technician
 * halfway down the Southwest Freeway with an error where their next turn should
 * be. `CONTINUE` draws a straight arrow and the step's own `instruction` text
 * is read out beside it, which is always right even when the enum is not.
 * Wrong-looking beats absent; `maneuverFromGoogle` makes the same trade for the
 * same reason on the other side of the wire.
 *
 * `.default` covers the field being missing entirely, which is the same problem
 * arriving by a different route.
 */
const maneuverSchema = z
  .string()
  .default('CONTINUE')
  .transform((value): NavManeuver =>
    KNOWN_MANEUVERS.has(value) ? (value as NavManeuver) : 'CONTINUE',
  );

const navigationStepSchema = z.object({
  maneuver: maneuverSchema,
  /** The router's own words. Required: it is the fallback the enum leans on. */
  instruction: z.string(),
  /** The road being joined, when the router names one separately. */
  roadName: z.string().nullable().default(null),
  distanceMeters: z.number(),
  /**
   * Free-flow seconds, from `staticDuration` -- **not** traffic-aware, unlike
   * the leg's own duration below. The two do not sum, and in Houston at five
   * o'clock the gap is minutes, so this is for ordering and the step list and
   * must never be printed as "time to the next turn" beside the HUD's ETA.
   */
  durationSeconds: z.number(),
  /** This step's own shape. Begins where the previous step ended. */
  polyline: z.array(latLngSchema).default([]),
});

/**
 * No field here is called `id`, and none may be.
 *
 * `reconcileMobileState` treats any `{ id: string }` it meets as a revisioned
 * entity and will happily resurrect one the server has dropped. A leg is a
 * fact about one moment, not an entity with a life of its own, so the stop it
 * drives to is `toStopId`.
 */
export const navigationLegSchema = z
  .object({
    toStopId: z.string(),
    /** Where the leg was drawn from, `[latitude, longitude]`. */
    from: latLngSchema,
    /** The stop itself, `[latitude, longitude]`. */
    to: latLngSchema,
    distanceMeters: z.number(),
    /** Traffic-aware when `source` is GOOGLE_TRAFFIC. The number the HUD prints. */
    durationSeconds: z.number(),
    steps: z.array(navigationStepSchema).default([]),
    /** The whole leg. Steps laid end to end. */
    polyline: z.array(latLngSchema).default([]),
    /**
     * Strict, unlike the maneuver above, and the contrast is the point.
     *
     * This drives the caveat printed under every drive time. Guessing it is the
     * `estimated: true` bug over again -- that flag described the free-flow
     * router on every route long after Google had become the one answering, so
     * "does not account for traffic" was false on every route production drew.
     * A third router means editing `NavigationLeg` in `shared/` anyway, and
     * this line comes with it.
     */
    source: z.enum(['GOOGLE_TRAFFIC', 'OSRM_FREE_FLOW']),
    /** When it was drawn, so the screen can tell a fresh leg from a held one. */
    drawnAt: z.string(),
  })
  /**
   * Null is an ordinary answer, not a failure: the stop may have no coordinate,
   * or the router may refuse the drive. The screen says so rather than showing
   * a spinner over a leg that is never coming.
   */
  .nullable();

/**
 * What the office is required to print beside the map.
 *
 * Nullable for the same reason `floorPlanSchema` is: a deployment with no map
 * credentials has no tiles to serve, and that is a state to report rather than
 * an error to throw.
 *
 * There is no key in this payload and there must never be one. The phone
 * fetches tiles from our own backend, which holds the provider credential; a
 * key in the bundle is a key published to every handset, and it cannot be
 * rotated without a store release.
 */
export const mapAttributionSchema = z
  .object({
    attribution: z.string(),
  })
  .nullable();
