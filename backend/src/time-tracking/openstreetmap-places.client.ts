import { Injectable, Logger } from '@nestjs/common';
import { haversineMeters } from '@texasrenters/shared';

/**
 * What OpenStreetMap calls the place a technician stopped at.
 *
 * Asked only for a stop away from the properties that none of our own data
 * could name, to say "The Home Depot" rather than a pair of coordinates.
 *
 * OpenStreetMap, not Mapbox or Google, because a stop's name is kept with the
 * hours it was paid for, and OpenStreetMap is the one source whose answers may
 * be kept (ODbL, with the attribution the timesheet shows). Mapbox's places
 * are for temporary use only, and Google's names may not be cached at all --
 * and Google's billing has lapsed twice.
 *
 * Nominatim's public service asks for one request a second at most and an
 * application that says who it is; this is a handful a day, one at a time.
 * Only the stop's position is sent, rounded to about ten metres, and nothing
 * about who stood there.
 *
 * Never throws. A lookup that fails is tried again on a later sweep.
 */

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org';
const REQUEST_TIMEOUT_MS = 10_000;
/** Nominatim's own limit is one a second; a little over it, to be a good neighbour. */
const SPACING_MS = 1_100;
const USER_AGENT = 'TexasRentersInspection/1.0 (+https://inspection.texasrenters.com)';

/**
 * A named place further than this from the stop is somebody else's.
 *
 * 150 m, because a store's position in OpenStreetMap is the middle of its
 * building and a big-box store is a hundred metres deep from the car park.
 */
const POI_WITHIN_METERS = 150;
/** An address further than this is a different lot. */
const ADDRESS_WITHIN_METERS = 100;

export interface PlaceAnswer {
  kind: 'BUSINESS' | 'ADDRESS';
  name: string | null;
  address: string | null;
}

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
}

/** "1234 FM 1960 Rd W, Houston", from what Nominatim says the address is. */
export function formatNominatimAddress(address: unknown): string | null {
  if (!address || typeof address !== 'object') return null;
  const parts = address as NominatimAddress;
  const street = [parts.house_number, parts.road].filter(Boolean).join(' ').trim();
  const place = parts.city ?? parts.town ?? parts.village ?? parts.suburb ?? '';
  const line = [street, place].filter(Boolean).join(', ');
  return line || null;
}

/**
 * Reads one Nominatim reverse answer without trusting any of it.
 *
 * Exported for its tests. Nominatim answers `200` with `{ "error": ... }` when
 * it found nothing, and with the nearest thing it has however far away that
 * is, so both the shape and the distance are checked here.
 */
export function parseNominatimReverse(
  body: unknown,
  stop: { latitude: number; longitude: number },
  layer: 'poi' | 'address',
): PlaceAnswer | null {
  if (!body || typeof body !== 'object' || 'error' in body) return null;
  const answer = body as { lat?: unknown; lon?: unknown; name?: unknown; address?: unknown };
  const latitude = Number(answer.lat);
  const longitude = Number(answer.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const metres = haversineMeters(stop, { latitude, longitude });
  const address = formatNominatimAddress(answer.address);

  if (layer === 'poi') {
    const name = typeof answer.name === 'string' ? answer.name.trim() : '';
    if (!name || metres > POI_WITHIN_METERS) return null;
    return { kind: 'BUSINESS', name: name.slice(0, 200), address: address?.slice(0, 300) ?? null };
  }
  if (!address || metres > ADDRESS_WITHIN_METERS) return null;
  return { kind: 'ADDRESS', name: null, address: address.slice(0, 300) };
}

@Injectable()
export class OpenStreetMapPlacesClient {
  private readonly logger = new Logger(OpenStreetMapPlacesClient.name);
  private lastRequestAt = 0;

  /** Off with `STOP_PLACE_LOOKUP_ENABLED=false`; stops are then named from our own data only. */
  get enabled(): boolean {
    return process.env.STOP_PLACE_LOOKUP_ENABLED !== 'false';
  }

  /**
   * The business at a stop, or failing that its street address. Null when
   * OpenStreetMap has nothing near enough; `undefined` when it could not be
   * asked, so the stop is tried again later rather than marked unknown.
   */
  async placeAt(stop: { latitude: number; longitude: number }): Promise<PlaceAnswer | null | undefined> {
    const business = await this.reverse(stop, 'poi');
    if (business !== null) return business;
    return this.reverse(stop, 'address');
  }

  private async reverse(
    stop: { latitude: number; longitude: number },
    layer: 'poi' | 'address',
  ): Promise<PlaceAnswer | null | undefined> {
    const wait = this.lastRequestAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();

    const query = new URLSearchParams({
      format: 'jsonv2',
      // About ten metres. Enough to find a store; no finer than it needs to be.
      lat: stop.latitude.toFixed(4),
      lon: stop.longitude.toFixed(4),
      zoom: '18',
      layer,
      addressdetails: '1',
    });
    const endpoint = (process.env.NOMINATIM_URL ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    try {
      const response = await fetch(`${endpoint}/reverse?${query.toString()}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn({ event: 'stop_place_lookup_refused', status: response.status, layer });
        return undefined;
      }
      return parseNominatimReverse(await response.json(), stop, layer);
    } catch (error) {
      this.logger.warn({
        event: 'stop_place_lookup_failed',
        layer,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
