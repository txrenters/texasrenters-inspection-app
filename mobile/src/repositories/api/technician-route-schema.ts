import { z } from 'zod';

/**
 * The technician's own day, ordered from where they are.
 *
 * Deliberately **not** cached for offline use, unlike the endpoints around it.
 * A route is a statement about where somebody is right now; served from a cache
 * an hour later it is not stale data, it is wrong data, and it would send
 * somebody to the stop they have already finished. No signal means no route,
 * which is honest.
 *
 * In its own module so it can be tested without the whole API repository.
 */
const routeStopSchema = z.object({
  inspectionId: z.string(),
  propertyId: z.string(),
  propertyName: z.string(),
  addressLine1: z.string(),
  city: z.string(),
  latitude: z.number(),
  longitude: z.number(),
});

/**
 * One point of a drawn line, **`[latitude, longitude]`**.
 *
 * Latitude first, matching `TechnicianRoute.geometry` and everything in
 * `shared/`. The backend's `decodePolyline` deliberately emits `[lon, lat]` and
 * `toLatLngPath` flips it once at the edge, so nothing on this side flips
 * again. Swapping them here would not fail: it draws a perfectly plausible
 * route in the Indian Ocean while every component looks correct on its own.
 * The tests therefore assert the *sign* of each value -- Texas is latitude ~29
 * positive, longitude ~-95 negative -- rather than its position.
 */
const latLngSchema = z.tuple([z.number(), z.number()]);

export const technicianRouteSchema = z.object({
  technicianId: z.string(),
  origin: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      /**
       * Null for a route from home, which describes where somebody lives rather
       * than a moment they were somewhere. Required as a string, this refused
       * every route drawn before the phone had reported that day -- so the
       * suggested order vanished for exactly the stretch of the morning it
       * exists for.
       */
      recordedAt: z.string().nullable(),
    })
    .nullable(),
  stops: z.array(routeStopSchema),
  legs: z.array(
    z.object({
      fromStopId: z.string().nullable(),
      toStopId: z.string(),
      distanceMeters: z.number(),
      durationSeconds: z.number(),
    }),
  ),
  totalDistanceMeters: z.number(),
  totalDurationSeconds: z.number(),
  unroutable: z.array(
    z.object({
      inspectionId: z.string(),
      propertyName: z.string(),
      /**
       * `NO_COORDINATES` never geocoded. `OUTSIDE_SERVICE_AREA` has a
       * coordinate no road we can route on is near. Optional for the reason
       * every field below is -- see the note there.
       */
      reason: z.enum(['NO_COORDINATES', 'OUTSIDE_SERVICE_AREA']).optional(),
    }),
  ),
  /**
   * Which router timed the drive. Optional, so a handset on this bundle still
   * reads a route from a server that has not started sending it.
   */
  source: z.enum(['GOOGLE_TRAFFIC', 'OSRM_FREE_FLOW']).nullable().optional(),

  /**
   * ## Everything below is optional or defaulted, and that is not defensiveness
   *
   * The backend has been sending all of it for months -- `planDay` returns the
   * whole `TechnicianRoute` and the controller hands it straight to the wire.
   * This schema is a plain `z.object`, so it silently stripped every field it
   * did not name, and the phone drew a route it had the geometry for as a list
   * of stops with a straight line between them.
   *
   * They are optional because zod refuses the **whole object** for one missing
   * required field, and `route()` has no offline cache to fall back on: a
   * rejected parse is not a stale route, it is no route at all. That has
   * already happened here once, in production. `origin.recordedAt` was required
   * as a string; a route drawn from home carries none; so the suggested order
   * vanished for exactly the stretch of the morning it exists for. Every field
   * added since is defaulted so that a handset ahead of the server, or behind
   * it, still gets the stops.
   */

  /** The drive along the road, `[latitude, longitude]`. Empty when not drawn. */
  geometry: z.array(latLngSchema).default([]),
  /**
   * The day so far -- finished stops in the order they were finished, and the
   * drive through them. Drawn grey under the orange line of what is left.
   */
  history: z
    .object({
      stops: z.array(routeStopSchema).default([]),
      geometry: z.array(latLngSchema).default([]),
    })
    .default({ stops: [], geometry: [] }),
  /**
   * Which kind of starting point this was drawn from.
   *
   * A route from somebody's house and a route from where they are standing are
   * different claims, and navigation must not offer to drive the first one.
   */
  originKind: z.enum(['LIVE', 'LAST_KNOWN', 'HOME']).nullable().optional(),
  /**
   * A position was reported and had to be refused -- it is nowhere near a road
   * we can route on. Distinct from `origin: null`, which means no handset has
   * reported at all, so the screen can say which of the two happened.
   */
  originOutsideServiceArea: z.boolean().default(false),
  /**
   * The straight line to the nearest stop when no road route is possible.
   *
   * Carries **no duration** on purpose: a flight time needs airports and
   * schedules this system does not have, and one derived from distance would be
   * wrong by hours. Distance over the ground is a fact; "how long" is not one
   * we can answer.
   */
  airTravel: z
    .object({ inspectionId: z.string(), distanceMeters: z.number() })
    .nullable()
    .optional(),
});
