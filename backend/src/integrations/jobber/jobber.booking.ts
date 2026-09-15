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
}

/**
 * The Jobber property a visit to this building and unit is booked against.
 *
 * The link for the unit first; then the building's own link, which is how the
 * office books a duplex under one address with a tenant per unit in the
 * Details. Two different Jobber properties at either level is refused, never
 * guessed: booking against the wrong one sends a technician to somebody else's
 * door. The quarter planner's booking looked up the building alone and took the
 * first link it found.
 */
export function pickJobberProperty(links: PropertyLinkRow[], unitId: string | null): LinkedJobberProperty {
  const one = (rows: PropertyLinkRow[]): LinkedJobberProperty | null => {
    const ids = new Set(rows.map((row) => row.jobberPropertyId));
    if (ids.size > 1) return { status: 'AMBIGUOUS' };
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
  const links = await client.jobberPropertyLink.findMany({
    where: { organizationId, propertywareBuildingId: place.buildingId, status: JobberLinkStatus.LINKED },
    select: { jobberPropertyId: true, jobberAddress: true, propertywareUnitId: true },
  });
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
