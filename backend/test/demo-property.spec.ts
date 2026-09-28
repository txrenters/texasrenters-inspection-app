import { Prisma } from '@prisma/client';
import {
  DEMO_PROPERTY_SOURCE_SYSTEM,
  TRUSTWORTHY_PRECISIONS,
  geocodableAddress,
} from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import {
  DEMO_PROPERTY_LIMIT,
  demoPropertySequence,
  demoPropertyFixture,
  nextDemoSequence,
} from '../src/admin/demo-property';
import { GEOCODE_SOURCE } from '../src/admin/property-geocoding.service';
import { PROPERTYWARE_SOURCE_SYSTEM } from '../src/integrations/propertyware/propertyware.constants';
import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';

/**
 * The only write into `propertyware_buildings` that is not the Propertyware sync.
 *
 * It exists so the office can demonstrate the app without booking a visit at a
 * real tenant's home. What makes that safe is a single column: `sourceSystem`.
 * Every query the sync makes is scoped to `propertyware`, so a row written as
 * `demo` is a row no sync reads, compares, touches or deactivates — and the
 * console labels it from the same column, so what the sync ignores is exactly
 * what a coordinator sees marked as a demo.
 *
 * These tests pin that column, the coordinates that keep the property off the
 * geocoding queue, and the two refusals. A demo property that silently became
 * indistinguishable from a managed home is the failure worth catching here.
 */

const ORG = '00000000-0000-4000-8000-000000000002';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000f';

const user = { id: '00000000-0000-4000-8000-000000000001', organizationId: ORG } as AuthenticatedUser;

/** The shape the `create` select returns, so `buildingTotalArea` can run. */
const createdRow = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  externalId: 'demo-property-1',
  name: 'Demo Property 1',
  addressLine1: '1001 Demo Ranch Road',
  addressLine2: null,
  city: 'Katy',
  state: 'TX',
  postalCode: '77494',
  sourceStatus: 'Occupied',
  sourceSystem: DEMO_PROPERTY_SOURCE_SYSTEM,
  isActive: true,
  lastSyncedAt: new Date('2026-09-29T12:00:00.000Z'),
  updatedAt: new Date('2026-09-29T12:00:00.000Z'),
  totalArea: 1_850,
  areaUnits: 'Sq Ft',
  category: 'RESIDENTIAL',
  manualTotalArea: null,
  manualAreaUnit: null,
  portfolio: null,
  _count: { units: 0, inspections: 0 },
  ...overrides,
});

function build(
  options: { existing?: number | string[]; createRejects?: unknown } = {},
) {
  const create =
    options.createRejects === undefined
      ? jest.fn().mockResolvedValue(createdRow())
      : jest.fn().mockRejectedValue(options.createRejects);
  // A number means "this many, numbered from one"; a list pins the exact ids,
  // which is what the gap cases need.
  const externalIds =
    typeof options.existing === 'number'
      ? Array.from({ length: options.existing }, (_, index) => `demo-property-${index + 1}`)
      : (options.existing ?? []);
  const auditCreate = jest.fn().mockResolvedValue({});
  const findMany = jest
    .fn()
    .mockResolvedValue(externalIds.map((externalId) => ({ externalId })));
  const prisma = {
    propertywareBuilding: { create, findMany },
    auditLog: { create: auditCreate },
  };
  const bump = jest.fn().mockResolvedValue(undefined);
  const service = new AdminService(
    prisma as never,
    {} as never,
    undefined,
    undefined,
    { bump } as never,
  );
  return { service, prisma, create, auditCreate, bump, findMany };
}

const dataOf = (create: jest.Mock) => create.mock.calls[0][0].data;

describe('creating a demo property', () => {
  it('writes a source system no sync query matches', async () => {
    // The isolation mechanism, and the only reason this feature is safe. A row
    // written as `propertyware` would be swept by the nightly reconciliation,
    // which cannot see a record Propertyware never returned.
    const { service, create } = build();
    await service.createDemoProperty(user);

    expect(dataOf(create).sourceSystem).toBe(DEMO_PROPERTY_SOURCE_SYSTEM);
    expect(dataOf(create).sourceSystem).not.toBe(PROPERTYWARE_SOURCE_SYSTEM);
  });

  it('creates it in the caller’s organization, never one passed in', async () => {
    const { service, create } = build();
    await service.createDemoProperty(user);

    expect(dataOf(create).organizationId).toBe(ORG);
    expect(dataOf(create).organizationId).not.toBe(OTHER_ORG);
  });

  it('reads only this organization’s demo properties when numbering', async () => {
    // Two organizations demonstrating the app must not number over each other,
    // and the read must not include the 570 real properties either.
    const { service, findMany } = build({ existing: 2 });
    await service.createDemoProperty(user);

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, sourceSystem: DEMO_PROPERTY_SOURCE_SYSTEM },
      select: { externalId: true },
    });
  });

  it('numbers from every demo property, including deactivated ones', async () => {
    // The unique key on `externalId` ignores `isActive`, so numbering that
    // skipped a deactivated one would collide with it rather than produce the
    // next number.
    const { service, create } = build({ existing: 3 });
    await service.createDemoProperty(user);

    expect(dataOf(create).externalId).toBe('demo-property-4');
    expect(dataOf(create).name).toBe('Demo Property 4');
  });

  it('numbers past a gap a delete left, rather than into it', async () => {
    // The bug that arrives with the delete button. Delete Demo Property 2 of
    // three and the *count* is two, so numbering from it proposes 3 — which
    // still exists. The unique key would reject it and the button would refuse
    // for as long as the gap did, saying "it already exists" about a property
    // the person had just deleted.
    const { service, create } = build({
      existing: ['demo-property-1', 'demo-property-3'],
    });
    await service.createDemoProperty(user);

    expect(dataOf(create).externalId).toBe('demo-property-4');
  });

  it('arrives already placed, so it is on the map at once', async () => {
    // The address is fictional and no geocoder will ever place it — the two
    // existing test fixtures in the portfolio are both among the properties
    // that came back unplaced, and an unplaced property is simply absent from
    // the map with nothing to say why.
    const { service, create } = build();
    await service.createDemoProperty(user);

    const data = dataOf(create);
    expect(Number(data.latitude)).toBeCloseTo(29.7858, 4);
    expect(Number(data.longitude)).toBeCloseTo(-95.8243, 4);
  });

  it('records the address it was placed for, so nothing re-queues it', async () => {
    // `geocodedFor` is compared against exactly this string to decide whether a
    // property still needs looking up. A formatting difference would put the
    // demo property back in the geocoding queue every single night.
    const { service, create } = build();
    await service.createDemoProperty(user);

    const data = dataOf(create);
    expect(data.geocodedFor).toBe(
      geocodableAddress({
        addressLine1: data.addressLine1,
        city: data.city,
        state: data.state,
        postalCode: data.postalCode,
      }),
    );
    // And not `CENSUS`, which is what the upgrade pass adopts and would spend a
    // Google lookup trying to improve a coordinate that was never measured.
    expect(data.geocodeSource).not.toBe(GEOCODE_SOURCE);
  });

  it('is placed precisely enough to be drawn as the property', async () => {
    // `CENTROID` is outside `TRUSTWORTHY_PRECISIONS`, and a demo property held
    // to be too vague to draw is a demo property that is not on the map — which
    // is most of what there is to demonstrate.
    const { service, create } = build();
    await service.createDemoProperty(user);

    expect(TRUSTWORTHY_PRECISIONS).toContain(dataOf(create).geocodePrecision);
  });

  it('is active and occupied, because a property nobody can inspect demonstrates nothing', async () => {
    const { service, create } = build();
    await service.createDemoProperty(user);

    const data = dataOf(create);
    expect(data.isActive).toBe(true);
    // `sourceStatus` is what the Occupied tab filters on, and the occupied
    // walkthrough is the workflow worth demonstrating.
    expect(data.sourceStatus).toBe('Occupied');
  });

  it('records who created it', async () => {
    // A demo property appearing in the portfolio with no record of who put it
    // there is the one outcome worth preventing.
    const { service, auditCreate } = build();
    await service.createDemoProperty(user);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG,
      actorUserId: user.id,
      action: 'demo_property.created',
      entityType: 'PropertywareBuilding',
    });
  });

  it('clears the caches the list and the dashboard read', async () => {
    // The properties list is cached per organization, so without this the new
    // property is invisible until the entry expires — which reads exactly like
    // the button having done nothing.
    const { service, bump } = build();
    await service.createDemoProperty(user);

    const bumped = bump.mock.calls.map((call) => call[0]);
    expect(bumped).toEqual(expect.arrayContaining(['properties', 'propertySearch', 'dashboard']));
    for (const call of bump.mock.calls) expect(call[1]).toBe(ORG);
  });
});

describe('when a demo property must be refused', () => {
  it('refuses once the organization holds the limit', async () => {
    // This writes into the table every surface reads from. The failure it
    // prevents is somebody holding the button down and pushing the real
    // portfolio off the first page of the list.
    const { service, create } = build({ existing: DEMO_PROPERTY_LIMIT });

    await expect(service.createDemoProperty(user)).rejects.toMatchObject({
      status: 409,
      code: 'DEMO_PROPERTY_LIMIT_REACHED',
    });
    // Refused before writing, so a refusal costs nothing.
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a double-click as a conflict rather than a crash', async () => {
    // Two clicks read the same count and compose the same external id; the
    // unique key rejects the second, which is the behaviour we want because the
    // alternative is two identical demo properties. It has to read as a
    // conflict, not a 500.
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service } = build({ createRejects: duplicate });

    await expect(service.createDemoProperty(user)).rejects.toMatchObject({
      status: 409,
      code: 'DEMO_PROPERTY_EXISTS',
    });
  });

  it('does not disguise any other database failure as a conflict', async () => {
    // A lost connection is not "it already exists", and reporting it as one
    // would send somebody to refresh a list that was never the problem.
    const other = new Prisma.PrismaClientKnownRequestError('gone', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const { service } = build({ createRejects: other });

    await expect(service.createDemoProperty(user)).rejects.not.toBeInstanceOf(ApplicationError);
  });
});

/**
 * Deleting one, and the demonstration it holds.
 *
 * Two boundaries are the whole point of these tests. The first is that the
 * endpoint cannot reach a Propertyware property: `sourceSystem` is in the
 * lookup, so a real one is *not found* rather than refused, and no argument
 * widens that. The second is that `properties:manage` is not a way around
 * `inspections:delete` — a demo property carrying recordings needs the key that
 * gates destroying recordings everywhere else.
 */
describe('deleting a demo property', () => {
  const PROPERTY_ID = '00000000-0000-4000-8000-0000000000aa';

  const actor = (permissions: string[] = []) =>
    ({ ...user, permissions } as unknown as AuthenticatedUser);

  function buildDelete(
    options: { found?: boolean; inspections?: number; transactionRejects?: unknown } = {},
  ) {
    const inspections = Array.from({ length: options.inspections ?? 0 }, (_, index) => ({
      id: `inspection-${index + 1}`,
    }));
    const tx = {
      baselineMedia: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      baselineAreaCondition: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      baselineInspection: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      floorPlanExtractionJob: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      propertyFloorPlan: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      propertyArea: { deleteMany: jest.fn().mockResolvedValue({ count: 15 }) },
      propertyFloor: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      property: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      propertywareLease: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      jobberPropertyLink: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      propertywareUnit: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      propertywareBuilding: { delete: jest.fn().mockResolvedValue({}) },
    };
    /** Records the order the deletes were issued in, which is the fragile part. */
    const order: string[] = [];
    for (const [table, delegate] of Object.entries(tx))
      for (const [verb, fn] of Object.entries(delegate))
        (fn as jest.Mock).mockImplementation(async () => {
          order.push(`${table}.${verb}`);
          return { count: 0 };
        });

    const auditCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      propertywareBuilding: {
        findFirst: jest.fn().mockResolvedValue(
          options.found === false
            ? null
            : { id: PROPERTY_ID, name: 'Demo Property 1', externalId: 'demo-property-1' },
        ),
      },
      inspection: { findMany: jest.fn().mockResolvedValue(inspections) },
      auditLog: { create: auditCreate },
      $transaction:
        options.transactionRejects === undefined
          ? jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx))
          : jest.fn().mockRejectedValue(options.transactionRejects),
    };
    const bump = jest.fn().mockResolvedValue(undefined);
    const publish = jest.fn().mockResolvedValue(undefined);
    const service = new AdminService(
      prisma as never,
      {} as never,
      undefined,
      undefined,
      { bump, publish } as never,
    );
    // The inspection erase is not re-tested here: it has its own delete order
    // across a dozen tables and its own coverage. What matters is that this
    // path delegates to it rather than growing a second copy.
    const erase = jest
      .spyOn(service as unknown as { eraseInspection: unknown } as never, 'eraseInspection' as never)
      .mockResolvedValue({ orphanedStorageObjects: 0 } as never);
    return { service, prisma, tx, order, auditCreate, bump, publish, erase };
  }

  it('cannot be pointed at a Propertyware property', async () => {
    // `sourceSystem` is in the `where`, so the lookup itself is the boundary.
    const { service, prisma } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(prisma.propertywareBuilding.findFirst.mock.calls[0][0].where).toEqual({
      id: PROPERTY_ID,
      organizationId: ORG,
      sourceSystem: DEMO_PROPERTY_SOURCE_SYSTEM,
    });
  });

  it('reports a real property as not found, telling the reader nothing about it', async () => {
    // 404 rather than 403: somebody who cannot delete it has no business
    // learning whether the id was a real property or no property at all.
    const { service } = buildDelete({ found: false });

    await expect(service.deleteDemoProperty(actor(), PROPERTY_ID)).rejects.toMatchObject({
      status: 404,
      code: 'DEMO_PROPERTY_NOT_FOUND',
    });
  });

  it('deletes a clean demo property without needing inspections:delete', async () => {
    // The ordinary case, and the reason the controller does not simply require
    // both keys: a demo property nobody walked holds nothing irreversible, and
    // the person who created it must be able to remove it.
    const { service, tx, erase } = buildDelete({ inspections: 0 });
    const result = await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(erase).not.toHaveBeenCalled();
    expect(tx.propertywareBuilding.delete).toHaveBeenCalledWith({ where: { id: PROPERTY_ID } });
    expect(result).toMatchObject({ deleted: true, inspectionsErased: 0 });
  });

  it('refuses to cascade into inspections without inspections:delete', async () => {
    // The boundary that matters. Otherwise this endpoint is a way around a
    // permission the office deliberately grants to almost nobody.
    const { service, erase, tx } = buildDelete({ inspections: 2 });

    await expect(service.deleteDemoProperty(actor(), PROPERTY_ID)).rejects.toMatchObject({
      status: 409,
      code: 'DEMO_PROPERTY_HAS_INSPECTIONS',
    });
    expect(erase).not.toHaveBeenCalled();
    expect(tx.propertywareBuilding.delete).not.toHaveBeenCalled();
  });

  it('says how many inspections are in the way', async () => {
    // "It cannot be deleted" sends somebody hunting. The count and the
    // permission name are the two facts that let them act.
    const { service } = buildDelete({ inspections: 3 });

    await expect(service.deleteDemoProperty(actor(), PROPERTY_ID)).rejects.toMatchObject({
      message: expect.stringContaining('3 inspections'),
    });
    await expect(service.deleteDemoProperty(actor(), PROPERTY_ID)).rejects.toMatchObject({
      message: expect.stringContaining('inspections:delete'),
    });
  });

  it('erases every inspection through the path that already owns that order', async () => {
    const { service, erase } = buildDelete({ inspections: 2 });
    const result = await service.deleteDemoProperty(actor(['inspections:delete']), PROPERTY_ID);

    expect(erase).toHaveBeenCalledTimes(2);
    expect(result.inspectionsErased).toBe(2);
  });

  it('only counts inspections belonging to this organization and this property', async () => {
    const { service, prisma } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(prisma.inspection.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      propertywareBuildingId: PROPERTY_ID,
    });
  });

  it('removes the Property shadow, which no foreign key would have taken with it', async () => {
    // `ensureStandardLayout` upserts a `Property` row carrying the same id, and
    // nothing relates the two tables. Left behind it is an orphan that
    // `Property`'s own geocoding pass keeps looking up for ever.
    const { service, tx } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(tx.propertyArea.deleteMany).toHaveBeenCalledWith({
      where: { propertyId: PROPERTY_ID },
    });
    expect(tx.property.deleteMany).toHaveBeenCalledWith({
      where: { id: PROPERTY_ID, organizationId: ORG },
    });
  });

  it('deletes children before the rows they restrict', async () => {
    // The order is dictated by the schema and every step is a `Restrict` that
    // would otherwise refuse. Pinned because a reordering would only fail
    // against a real database, which these tests are not.
    const { service, order } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    const at = (step: string) => order.indexOf(step);
    expect(at('baselineMedia.deleteMany')).toBeLessThan(at('baselineAreaCondition.deleteMany'));
    expect(at('baselineAreaCondition.deleteMany')).toBeLessThan(
      at('baselineInspection.deleteMany'),
    );
    expect(at('baselineAreaCondition.deleteMany')).toBeLessThan(at('propertyArea.deleteMany'));
    expect(at('floorPlanExtractionJob.deleteMany')).toBeLessThan(
      at('propertyFloorPlan.deleteMany'),
    );
    expect(at('propertyFloorPlan.deleteMany')).toBeLessThan(at('propertyArea.deleteMany'));
    // Areas cite a floor and a unit, and both restrict.
    expect(at('propertyArea.deleteMany')).toBeLessThan(at('propertyFloor.deleteMany'));
    expect(at('propertyFloor.deleteMany')).toBeLessThan(at('propertywareUnit.deleteMany'));
    expect(at('propertyArea.deleteMany')).toBeLessThan(at('property.deleteMany'));
    // The building last of all.
    expect(at('propertywareBuilding.delete')).toBe(order.length - 1);
  });

  it('does it all in one transaction, so a surprise leaves the property intact', async () => {
    const { service, prisma } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('turns an unanticipated foreign key into a refusal, not a crash', async () => {
    // The transaction has already rolled back, so the honest thing to say is
    // that the property is still there — not that the server broke.
    const blocked = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const { service } = buildDelete({ transactionRejects: blocked });

    await expect(service.deleteDemoProperty(actor(), PROPERTY_ID)).rejects.toMatchObject({
      status: 409,
      code: 'DEMO_PROPERTY_STILL_REFERENCED',
    });
  });

  it('records what was destroyed, including the inspection count', async () => {
    // The audit row outlives the property, and the inspection count is the part
    // nobody can reconstruct afterwards.
    const { service, auditCreate } = buildDelete({ inspections: 2 });
    await service.deleteDemoProperty(actor(['inspections:delete']), PROPERTY_ID);

    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG,
      actorUserId: user.id,
      action: 'demo_property.deleted',
      entityType: 'PropertywareBuilding',
      metadata: expect.objectContaining({ inspectionsErased: 2 }),
    });
  });

  it('tells every open console the inspection list changed, but only when it did', async () => {
    const withInspections = buildDelete({ inspections: 1 });
    await withInspections.service.deleteDemoProperty(
      actor(['inspections:delete']),
      PROPERTY_ID,
    );
    expect(withInspections.publish).toHaveBeenCalledWith({
      type: 'inspection.changed',
      organizationId: ORG,
    });

    // A clean demo property changed no inspection, and saying otherwise would
    // make every console refetch a list that did not move.
    const clean = buildDelete({ inspections: 0 });
    await clean.service.deleteDemoProperty(actor(), PROPERTY_ID);
    expect(clean.publish).not.toHaveBeenCalled();
  });

  it('clears the detail cache as well as the list', async () => {
    // The deleted property has its own cached detail response, and leaving it
    // would serve a property that no longer exists.
    const { service, bump } = buildDelete();
    await service.deleteDemoProperty(actor(), PROPERTY_ID);

    expect(bump.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['properties', 'propertySearch', 'propertyDetails', 'dashboard']),
    );
  });
});

describe('the fixture itself', () => {
  it('gives each demo property its own address and external id', async () => {
    // Two demo properties at the same address would be indistinguishable in
    // every list that shows an address rather than a name.
    const first = demoPropertyFixture(1);
    const second = demoPropertyFixture(2);

    expect(first.externalId).not.toBe(second.externalId);
    expect(first.addressLine1).not.toBe(second.addressLine1);
    expect(first.name).not.toBe(second.name);
  });

  it('names itself a demo in the one field every list shows', async () => {
    // The badge comes from `sourceSystem`, but the name is what a plain text
    // export, a Jobber title or a log line carries.
    expect(demoPropertyFixture(1).name).toMatch(/demo/i);
  });

  it('round-trips its sequence through the external id', () => {
    // The delete path depends on this: numbering reads the sequence back out of
    // the ids it wrote, so the two halves have to agree.
    expect(demoPropertySequence(demoPropertyFixture(7).externalId)).toBe(7);
  });

  it('claims no sequence from a Propertyware external id', () => {
    // A real building's id must never be read as a demo number, or a sync would
    // decide what the next demo property is called.
    expect(demoPropertySequence('PW-100234')).toBeNull();
    expect(demoPropertySequence('demo-property-')).toBeNull();
    expect(demoPropertySequence('demo-property-nope')).toBeNull();
  });

  it('starts at one when there are none', () => {
    expect(nextDemoSequence([])).toBe(1);
  });

  it('ignores ids it does not recognize when numbering', () => {
    // Defensive: a demo row whose id came from somewhere else must not make the
    // next number `NaN`, which `Math.max` would happily produce.
    expect(nextDemoSequence(['PW-100234', 'demo-property-2'])).toBe(3);
  });
});
