/**
 * The property the office can create on purpose, to demonstrate the app.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Every property in the application arrives from the Propertyware sync. There
 * has never been a `POST /admin/properties`, deliberately: Propertyware is the
 * source of record and nothing here can write back to it
 * (see `propertyware-is-read-only-no-write-path`). So a demonstration — showing
 * the console and the phone to a new technician, or walking the inspection
 * workflow end to end — had to be done against somebody's real home, with a
 * real tenant, and whatever it produced stayed in the portfolio afterwards.
 *
 * This is the one exception, and it is scoped as narrowly as an exception can
 * be: a single button, one fixed fixture, and a `sourceSystem` the sync does
 * not own.
 *
 * ── WHAT KEEPS IT OUT OF THE REAL PORTFOLIO ──────────────────────────────────
 *
 * `sourceSystem` is the whole isolation mechanism. Every query the Propertyware
 * sync makes against `propertyware_buildings` is scoped to
 * `PROPERTYWARE_SOURCE_SYSTEM`, so a row written with `DEMO_SOURCE_SYSTEM`:
 *
 * - is not in `getRecordCache`, so a sync never compares hashes against it and
 *   never upserts over it;
 * - is not in `touchRecords`, so its `lastSeenAt` is honestly the day it was
 *   created rather than the last time a sync ran;
 * - is not in `deactivateUnseen`, so the nightly reconciliation does not
 *   conclude that Propertyware has stopped listing it and take it out of the
 *   application. That sweep was *not* scoped by `sourceSystem` until this
 *   change; scoping it is what makes a demo property survive its first night.
 *
 * The unique key is `(organizationId, sourceSystem, externalId)`, so a demo
 * external id can never collide with a Propertyware one either.
 *
 * ── AND WHAT DELIBERATELY IS NOT ISOLATED ────────────────────────────────────
 *
 * The row is an ordinary active building in every other respect, because a
 * demonstration that cannot be inspected demonstrates nothing. It appears in
 * the properties list, on the map, and in the property picker when an
 * inspection is created — which is the point. It is labelled, not hidden: the
 * list shows a Demo badge from `sourceSystem`, so nobody mistakes it for a
 * house somebody lives in.
 *
 * Its rooms are not seeded here. `ensureStandardLayout` already gives a
 * property with no recorded areas the 15-area standard layout when the first
 * occupied, back-to-market, move-in or move-out inspection is created, so a
 * demo property gets exactly the layout every other bare property gets, from
 * the one implementation that owns that decision. A second copy of it here
 * would be a second thing to keep in step. See `every-property-now-has-a-layout`.
 */

import {
  DEMO_PROPERTY_SOURCE_SYSTEM,
  type GeocodePrecision,
  geocodableAddress,
} from '@texasrenters/shared';

/**
 * Not `propertyware`. This is the isolation boundary — see the note above, and
 * `PROPERTYWARE_SOURCE_SYSTEM`, which every sync query is scoped to.
 *
 * Re-exported from shared rather than declared twice: the console reads the same
 * word off the row to label it, and the two agreeing is the point.
 */
export const DEMO_SOURCE_SYSTEM = DEMO_PROPERTY_SOURCE_SYSTEM;

/**
 * How many demo properties one organization may hold.
 *
 * A guard rather than a policy: this button writes into the table the whole
 * application reads from, and the failure it prevents is somebody holding it
 * down and pushing six hundred real properties off the first page of the list.
 * Ten is far more than a demonstration needs and small enough to notice.
 */
export const DEMO_PROPERTY_LIMIT = 10;

/**
 * Where the demo property sits: a real point in Katy, in the middle of the
 * service area, on a street that exists.
 *
 * Coordinates are written at creation rather than left to the geocoder, for two
 * reasons. The first is that the address is fictional and the geocoder would
 * never place it — the two existing test fixtures in the portfolio,
 * `123 Demo Street` and `123 Texas St.`, are both among the 24 properties that
 * came back unplaced from the backfill, and an unplaced property is simply
 * absent from the map with nothing to say why. The second is that it must
 * appear immediately: a demonstration does not wait for the nightly geocoding
 * pass.
 *
 * `geocodeSource` is this fixture rather than `CENSUS`, which is what keeps the
 * `--upgrade-census` pass from adopting it and spending a Google lookup trying
 * to improve a coordinate that was never measured.
 *
 * `ROOFTOP` rather than `CENTROID`, and it is not a flattering lie: the address
 * is fictional, so this coordinate is the only place it is, which is exactly
 * what a rooftop match asserts. It also has to be trustworthy — `CENTROID` is
 * outside `TRUSTWORTHY_PRECISIONS`, so a demo property marked that way would be
 * held to be too vague to draw as "this is the property", which is the one thing
 * a demonstration needs it to do.
 */
const DEMO_LATITUDE = '29.785800';
const DEMO_LONGITUDE = '-95.824300';
export const DEMO_GEOCODE_SOURCE = 'DEMO';
const DEMO_GEOCODE_PRECISION: GeocodePrecision = 'ROOFTOP';

const DEMO_CITY = 'Katy';
const DEMO_STATE = 'TX';
const DEMO_POSTAL_CODE = '77494';

const DEMO_EXTERNAL_ID_PREFIX = 'demo-property-';

/** The external id for a sequence number. The only place the format is written. */
export const demoExternalId = (sequence: number) => `${DEMO_EXTERNAL_ID_PREFIX}${sequence}`;

/** The sequence a demo external id carries, or null if it carries none. */
export function demoPropertySequence(externalId: string): number | null {
  if (!externalId.startsWith(DEMO_EXTERNAL_ID_PREFIX)) return null;
  const sequence = Number(externalId.slice(DEMO_EXTERNAL_ID_PREFIX.length));
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

/**
 * The next sequence number, from the highest one already used.
 *
 * **Not the count.** Once a demo property can be deleted, the count stops being
 * the next number: delete Demo Property 2 of three and the count is two, so
 * numbering from it proposes 3 — which already exists, and the unique key
 * rejects it. The button would then refuse for as long as that gap existed, and
 * the refusal would read as "it already exists" about a property the person had
 * just deleted.
 *
 * Numbering from the maximum leaves gaps instead, which is the honest outcome:
 * Demo Property 2 is gone, the next one is 4, and nothing pretends otherwise.
 * The cap counts rows, not sequence numbers, so gaps cost nothing.
 */
export function nextDemoSequence(externalIds: readonly string[]): number {
  const used = externalIds
    .map(demoPropertySequence)
    .filter((sequence): sequence is number => sequence !== null);
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

/**
 * The row for the next demo property.
 *
 * `externalId` carries the sequence, which is what makes the button safe under a
 * double-click: both requests read the same set and compose the same external
 * id, and the unique key on `(organizationId, sourceSystem, externalId)` rejects
 * the second rather than quietly producing two identical demo properties. The
 * caller turns that into "one already exists", which is the truth.
 */
export function demoPropertyFixture(sequence: number) {
  const addressLine1 = `${1_000 + sequence} Demo Ranch Road`;
  const address = { addressLine1, city: DEMO_CITY, state: DEMO_STATE, postalCode: DEMO_POSTAL_CODE };
  return {
    sourceSystem: DEMO_SOURCE_SYSTEM,
    externalId: demoExternalId(sequence),
    idNumber: `DEMO-${String(sequence).padStart(3, '0')}`,
    name: `Demo Property ${sequence}`,
    abbreviation: `DEMO${sequence}`,
    propertyType: 'Single Family',
    ...address,
    addressLine2: null,
    country: 'US',
    /**
     * Occupied, because that is the inspection the office actually walks —
     * the occupied checklist is the longest workflow in the app and the one
     * worth demonstrating. It is also what the Occupied tab filters on.
     */
    sourceStatus: 'Occupied',
    totalArea: 1_850,
    areaUnits: 'Sq Ft',
    category: 'RESIDENTIAL',
    isActive: true,
    latitude: DEMO_LATITUDE,
    longitude: DEMO_LONGITUDE,
    // The shared composer, not a hand-written copy of its output: `geocodedFor`
    // is compared against exactly this string to decide whether a property
    // still needs looking up, so a formatting difference would put the demo
    // property back in the geocoding queue every night.
    geocodedFor: geocodableAddress(address),
    geocodeSource: DEMO_GEOCODE_SOURCE,
    geocodePrecision: DEMO_GEOCODE_PRECISION,
    // Written for the same reason the coordinate is: a placed property with no
    // record of when it was placed reads as one nothing has looked at yet.
    geocodedAt: new Date(),
  };
}
