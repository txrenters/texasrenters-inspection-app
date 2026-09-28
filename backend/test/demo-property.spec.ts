import { Prisma } from '@prisma/client';
import {
  DEMO_PROPERTY_SOURCE_SYSTEM,
  TRUSTWORTHY_PRECISIONS,
  geocodableAddress,
} from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import { DEMO_PROPERTY_LIMIT, demoPropertyFixture } from '../src/admin/demo-property';
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

function build(options: { existing?: number; createRejects?: unknown } = {}) {
  const create =
    options.createRejects === undefined
      ? jest.fn().mockResolvedValue(createdRow())
      : jest.fn().mockRejectedValue(options.createRejects);
  const auditCreate = jest.fn().mockResolvedValue({});
  const prisma = {
    propertywareBuilding: { create, count: jest.fn().mockResolvedValue(options.existing ?? 0) },
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
  return { service, prisma, create, auditCreate, bump };
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

  it('counts only this organization’s demo properties when numbering', async () => {
    // Two organizations demonstrating the app must not number over each other,
    // and the count must not include the 570 real properties either.
    const { service, prisma } = build({ existing: 2 });
    await service.createDemoProperty(user);

    expect(prisma.propertywareBuilding.count).toHaveBeenCalledWith({
      where: { organizationId: ORG, sourceSystem: DEMO_PROPERTY_SOURCE_SYSTEM },
    });
  });

  it('numbers from every demo property, including deactivated ones', async () => {
    // The unique key on `externalId` ignores `isActive`, so numbering from the
    // active count would collide with a demo property somebody had taken out
    // rather than producing the next one.
    const { service, create } = build({ existing: 3 });
    await service.createDemoProperty(user);

    expect(dataOf(create).externalId).toBe('demo-property-4');
    expect(dataOf(create).name).toBe('Demo Property 4');
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
});
