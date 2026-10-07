import type { Prisma } from '@prisma/client';

import type { PrismaService } from './prisma.service';

/**
 * A property's areas that are on no floor -- the sign, supra and lockbox, a
 * service's photographs -- found or created one request at a time.
 *
 * `PropertyArea`'s unique index (propertyId, unitId, floorId, name) does not
 * stop a second one: Postgres counts NULLs as distinct, floorId is always NULL
 * here and unitId often is. Two requests that both look before either writes
 * -- two phones, a retry, a prefetch racing the screen -- both create, and the
 * visit is given the area twice.
 */

type Client = Prisma.TransactionClient | PrismaService;

/** Which area: the building, its unit if any, and the name. */
export type FloorlessPlace = { propertyId: string; unitId: string | null; name: string };

/**
 * Holds this place's lock until the transaction ends, so whoever looks for the
 * area next waits for this transaction to commit and then sees what it wrote.
 *
 * Inside a transaction only: outside one the lock is released at once. Taking
 * it again in the same transaction is free. Taken after anything else the
 * transaction writes for the place -- the property row, the organization's
 * questions -- as every caller does, so two of them never wait on each other.
 */
export async function lockFloorlessArea(client: Client, place: FloorlessPlace) {
  const key = `property-area:${place.propertyId}:${place.unitId ?? ''}:${place.name}`;
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

/** The property's area of this name on no floor, created with `data` when there is none. */
export async function findOrCreateFloorlessArea(
  client: Client,
  place: FloorlessPlace,
  data: Omit<Prisma.PropertyAreaUncheckedCreateInput, keyof FloorlessPlace | 'floorId'>,
): Promise<string> {
  await lockFloorlessArea(client, place);
  const where = { ...place, floorId: null };
  const existing = await client.propertyArea.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  const created = await client.propertyArea.create({ data: { ...where, ...data }, select: { id: true } });
  return created.id;
}
