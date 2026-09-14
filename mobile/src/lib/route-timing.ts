import type { TechnicianDayRoute } from '../repositories/contracts';

/**
 * What a route's drive times are, in a few words, or null when that is unknown.
 *
 * Google times the drive against traffic; the fallback router has no traffic
 * data and describes an empty road at the speed limit. The summary used to say
 * "does not account for traffic" under every route -- including every one
 * Google had timed with it. Null for a server too old to say which it used,
 * because guessing either way would be a claim.
 */
export function routeTimingNote(source: TechnicianDayRoute['source']): string | null {
  if (source === 'GOOGLE_TRAFFIC') return 'Includes traffic.';
  if (source === 'OSRM_FREE_FLOW') return 'Estimate. Does not account for traffic.';
  return null;
}
