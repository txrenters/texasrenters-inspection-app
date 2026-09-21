import { JobberLinkStatus, type Prisma } from '@prisma/client';
import type { JobberPropertyLinkState } from '@texasrenters/shared';

import type { PrismaService } from '../../common/prisma.service';

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
 * written two ways -- "1103 East Hampton Drive • Pearland, Texas • 77584" and
 * "1103 E Hampton Dr • Pearland, TX • 77584-7620". The office abbreviates the
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
  return pickJobberProperty(links, place.unitId);
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
