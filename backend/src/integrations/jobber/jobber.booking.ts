import { JobberLinkStatus, type Prisma } from '@prisma/client';
import type { JobberPropertyLinkState } from '@texasrenters/shared';

import type { PrismaService } from '../../common/prisma.service';

import { addressKeyCandidates, formatJobberAddress, normalizeAddressKey } from './jobber.address';

type BookingClient = Prisma.TransactionClient | PrismaService;

export type LinkedJobberProperty =
  | { status: 'LINKED'; jobberPropertyId: string; address: string | null }
  | { status: Exclude<JobberPropertyLinkState, 'LINKED'> };

interface PropertyLinkRow {
  jobberPropertyId: string;
  jobberAddress: string | null;
  propertywareUnitId: string | null;
  /**
   * The day of the newest visit Jobber has against this property, as an ISO
   * string, or null if it has never been used.
   *
   * A string rather than a Date because that is what the column holds: every
   * `startAt` in `JobberVisitImport.payload` ends in `Z`, so the text sorts the
   * same way the instants do. A mixed-offset feed would break that, which is
   * why it is said out loud here as well as at the query.
   */
  lastUsedAt: string | null;
}

/**
 * The Jobber property a visit to this building and unit is booked against.
 *
 * The link for the unit first; then the building's own link, which is how the
 * office books a duplex under one address with a tenant per unit in the
 * Details. The quarter planner's booking looked up the building alone and took
 * the first link it found.
 *
 * ── TWO JOBBER PROPERTIES FOR ONE HOUSE ──────────────────────────────────────
 *
 * Sixty-two addresses exist **twice** in this office's Jobber, the same house
 * written two ways -- "1167 East Phantom Drive • Pearland, Texas • 77584" and
 * "1167 E Phantom Dr • Pearland, TX • 77584-0108". The office abbreviates the
 * street type (Drive to Dr, Lane to Ln) and Jobber kept both records; thirteen
 * of them are already labelled "(Do not use)".
 *
 * This used to refuse outright, which abandoned 61 outbound visits. The office
 * gave the rule (2026-09-22): **the record they used most recently is the live
 * one.** It is their own answer to their own data -- every one of the 62 has
 * visits booked against both copies, so nothing here could have worked it out
 * alone, and the newest visit is the only evidence of which record the office
 * is actually working in today.
 *
 * Still refused where the evidence is absent or level: no visit against either,
 * or the same newest day on both, is not an answer, and booking against the
 * wrong property sends a technician to somebody else's door.
 */
export function pickJobberProperty(links: PropertyLinkRow[], unitId: string | null): LinkedJobberProperty {
  const one = (rows: PropertyLinkRow[]): LinkedJobberProperty | null => {
    const ids = new Set(rows.map((row) => row.jobberPropertyId));
    if (ids.size > 1) {
      /**
       * Grouped by property first, because one Jobber property can hold more
       * than one link row -- a building link and a unit link both pointing at
       * it. Comparing rows rather than properties would read those two as a
       * tie and refuse a house that has only ever had one Jobber record in use.
       */
      const newestPerProperty = new Map<string, { row: PropertyLinkRow; lastUsedAt: string }>();
      for (const row of rows) {
        if (!row.lastUsedAt) continue;
        const held = newestPerProperty.get(row.jobberPropertyId);
        if (!held || row.lastUsedAt > held.lastUsedAt)
          newestPerProperty.set(row.jobberPropertyId, { row, lastUsedAt: row.lastUsedAt });
      }
      const ranked = [...newestPerProperty.values()].sort((left, right) =>
        right.lastUsedAt.localeCompare(left.lastUsedAt),
      );
      const [newest, next] = ranked;
      // A clear winner, or nothing. A tie on the day says they are both in use
      // this week, which is the office's problem to settle rather than ours.
      if (newest && newest.lastUsedAt !== next?.lastUsedAt)
        return {
          status: 'LINKED',
          jobberPropertyId: newest.row.jobberPropertyId,
          address: newest.row.jobberAddress,
        };
      return { status: 'AMBIGUOUS' };
    }
    const [row] = rows;
    return row ? { status: 'LINKED', jobberPropertyId: row.jobberPropertyId, address: row.jobberAddress } : null;
  };
  if (unitId) {
    const forUnit = one(links.filter((link) => link.propertywareUnitId === unitId));
    if (forUnit) return forUnit;
  }
  const forBuilding = one(links.filter((link) => !link.propertywareUnitId));
  if (forBuilding) return forBuilding;
  // A building inspected as a whole, whose only links name units.
  if (!unitId) return one(links) ?? { status: 'NOT_LINKED' };
  // Links for the other units say nothing about this one.
  return { status: 'NOT_LINKED' };
}

export async function linkedJobberProperty(
  client: BookingClient,
  organizationId: string,
  place: { buildingId: string; unitId: string | null },
): Promise<LinkedJobberProperty> {
  /**
   * Raw, for `lastUsedAt` alone.
   *
   * The day a visit happened lives in `JobberVisitImport.payload->>'startAt'`,
   * which Prisma cannot aggregate through a relation. Everything else about
   * this read is the ordinary scoped query it replaces -- organization,
   * building, and LINKED only.
   */
  const links = await client.$queryRaw<PropertyLinkRow[]>`
    SELECT link."jobberPropertyId",
           link."jobberAddress",
           link."propertywareUnitId",
           (SELECT max(visit.payload->>'startAt')
              FROM "JobberVisitImport" AS visit
             WHERE visit."linkId" = link.id) AS "lastUsedAt"
      FROM "JobberPropertyLink" AS link
     WHERE link."organizationId" = ${organizationId}::uuid
       AND link."propertywareBuildingId" = ${place.buildingId}::uuid
       AND link.status = ${JobberLinkStatus.LINKED}::"JobberLinkStatus"
  `;
  const linked = pickJobberProperty(links, place.unitId);
  if (linked.status !== 'NOT_LINKED') return linked;
  return (await jobberPropertyAtTheAddress(client, organizationId, place)) ?? linked;
}

interface PlaceAddressRow {
  addressLine1: string | null;
  postalCode: string | null;
  unitAddressLine1: string | null;
  unitPostalCode: string | null;
}

interface SeenJobberPropertyRow {
  jobberPropertyId: string | null;
  street1: string | null;
  street2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  lastUsedAt: string | null;
  linkStatus: string | null;
  linkedBuildingId: string | null;
  linkedAddressLine1: string | null;
  linkedPostalCode: string | null;
}

/**
 * The Jobber property at this place's own address, when no link names one.
 *
 * Sixteen Q4 2026 visits were never booked (2026-10-16), each refused as "not
 * linked". Six of them were at houses Jobber already held:
 * - **Two Propertyware records for one house** (two houses): Jobber's property
 *   was linked to the other record.
 * - **A unit with no link of its own** (two backhouses behind one house):
 *   Jobber holds one as a property of its own, "100 1/2 Example St", and books
 *   the other's work at the house, "100 Example St".
 * - **A property seen only on finished visits** (two houses): the sync skips a
 *   completed visit before it records its property, so no link was ever made.
 *
 * So the Jobber properties the sync has seen on any visit are read, and one
 * whose address is this place's -- street and five-digit ZIP, the matcher's
 * own key -- is booked against. The unit's own address is tried first when it
 * has one, then the building's.
 *
 * Refused, as before, wherever the answer is not plain:
 * - a property a person or the matcher linked to a house at another address,
 *   or set aside as not a property;
 * - one marked "(Do not use)";
 * - one with a unit on its second line, when this place is not that unit;
 * - two properties at the address the office used on the same day, or never.
 *
 * Each property is read at its newest visit, so an address corrected in Jobber
 * since is read as corrected.
 */
async function jobberPropertyAtTheAddress(
  client: BookingClient,
  organizationId: string,
  place: { buildingId: string; unitId: string | null },
): Promise<LinkedJobberProperty | null> {
  const [address] = await client.$queryRaw<PlaceAddressRow[]>`
    SELECT building."addressLine1",
           building."postalCode",
           unit."addressLine1" AS "unitAddressLine1",
           unit."postalCode" AS "unitPostalCode"
      FROM propertyware_buildings AS building
      LEFT JOIN propertyware_units AS unit
        ON unit.id = ${place.unitId}::uuid
       AND unit."buildingId" = building.id
     WHERE building."organizationId" = ${organizationId}::uuid
       AND building.id = ${place.buildingId}::uuid
  `;
  const buildingKey = normalizeAddressKey(address?.addressLine1, address?.postalCode);
  if (!buildingKey) return null;
  const unitKey = normalizeAddressKey(address?.unitAddressLine1, address?.unitPostalCode ?? address?.postalCode);
  const keys = unitKey && unitKey !== buildingKey ? [unitKey, buildingKey] : [buildingKey];
  const postal = buildingKey.split('|')[1]!;

  const seen = await client.$queryRaw<SeenJobberPropertyRow[]>`
    SELECT seen.*,
           link.status::text AS "linkStatus",
           link."propertywareBuildingId" AS "linkedBuildingId",
           linked."addressLine1" AS "linkedAddressLine1",
           linked."postalCode" AS "linkedPostalCode"
      FROM (
        SELECT DISTINCT ON (visit.payload->'property'->>'id')
               visit.payload->'property'->>'id' AS "jobberPropertyId",
               visit.payload->'property'->'address'->>'street1' AS street1,
               visit.payload->'property'->'address'->>'street2' AS street2,
               visit.payload->'property'->'address'->>'city' AS city,
               visit.payload->'property'->'address'->>'province' AS province,
               visit.payload->'property'->'address'->>'postalCode' AS "postalCode",
               max(visit.payload->>'startAt')
                 OVER (PARTITION BY visit.payload->'property'->>'id') AS "lastUsedAt"
          FROM "JobberVisitImport" AS visit
         WHERE visit."organizationId" = ${organizationId}::uuid
           AND visit.payload->'property'->>'id' IS NOT NULL
         ORDER BY visit.payload->'property'->>'id', visit."updatedAt" DESC
      ) AS seen
      LEFT JOIN "JobberPropertyLink" AS link
        ON link."organizationId" = ${organizationId}::uuid
       AND link."jobberPropertyId" = seen."jobberPropertyId"
      LEFT JOIN propertyware_buildings AS linked
        ON linked.id = link."propertywareBuildingId"
     WHERE left(regexp_replace(coalesce(seen."postalCode", ''), '[^0-9]', '', 'g'), 5) = ${postal}
  `;

  const usable = (row: SeenJobberPropertyRow) => {
    if (!row.jobberPropertyId) return false;
    if (/do not use/i.test(`${row.street1 ?? ''} ${row.street2 ?? ''}`)) return false;
    if (row.linkStatus === JobberLinkStatus.IGNORED) return false;
    // Somebody's answer that this property is another house stands.
    return !(
      row.linkStatus === JobberLinkStatus.LINKED &&
      row.linkedBuildingId !== place.buildingId &&
      normalizeAddressKey(row.linkedAddressLine1, row.linkedPostalCode) !== buildingKey
    );
  };
  for (const key of keys) {
    const atTheAddress = seen.filter(
      (row) => usable(row) && addressKeyCandidates(row.street1, row.street2, row.postalCode)[0] === key,
    );
    if (!atTheAddress.length) continue;
    const picked = pickJobberProperty(
      atTheAddress.map((row) => ({
        jobberPropertyId: row.jobberPropertyId!,
        jobberAddress: formatJobberAddress({
          addressLine1: row.street1,
          addressLine2: row.street2,
          city: row.city,
          state: row.province,
          postalCode: row.postalCode,
        }),
        propertywareUnitId: null,
        lastUsedAt: row.lastUsedAt,
      })),
      null,
    );
    // Two at the unit's own address is no reason to book at the building's.
    return picked.status === 'LINKED' ? picked : null;
  }
  return null;
}

/**
 * The Jobber user a technician is, as Jobber has already reported it.
 *
 * Nothing stores a Jobber user id. The sync matches a visit's assignees to our
 * accounts by email, so the reverse is read from the same place: the assignees
 * on visits already imported. An id is therefore only ever one Jobber gave for
 * that address. None, or two for one address, answers null, and the visit is
 * booked unassigned for the office to assign in Jobber -- the sync reads an
 * unassigned visit as no answer and leaves the assignment here alone.
 */
export async function jobberUserIdForEmail(
  client: BookingClient,
  organizationId: string,
  email: string | null | undefined,
): Promise<string | null> {
  const address = email?.trim().toLowerCase();
  if (!address) return null;
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT node->>'id' AS id
      FROM "JobberVisitImport" AS visit,
           jsonb_array_elements(
             CASE WHEN jsonb_typeof(visit.payload->'assignedUsers'->'nodes') = 'array'
                  THEN visit.payload->'assignedUsers'->'nodes'
                  ELSE '[]'::jsonb END
           ) AS node
     WHERE visit."organizationId" = ${organizationId}::uuid
       AND lower(node->'email'->>'raw') = ${address}
     LIMIT 2
  `;
  return rows.length === 1 ? rows[0]!.id : null;
}
