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
  unroutable: z.array(z.object({ inspectionId: z.string(), propertyName: z.string() })),
  /**
   * Which router timed the drive. Optional, so a handset on this bundle still
   * reads a route from a server that has not started sending it.
   */
  source: z.enum(['GOOGLE_TRAFFIC', 'OSRM_FREE_FLOW']).nullable().optional(),
});
