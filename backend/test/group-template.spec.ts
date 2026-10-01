import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import {
  GroupTemplateService,
  templateProblem,
  type GroupTemplateInput,
} from '../src/planning/group-template.service';

/**
 * The office's group templates (2026-09-30): its own grouping of the
 * benefit-package properties into days, made in the Group maker.
 */

const ORG = 'org-1';
const TEMPLATE = '6f0c1d2e-0000-4000-8000-000000000001';
const user = { id: 'user-1', organizationId: ORG, principalType: 'USER' } as unknown as AuthenticatedUser;

const group = (name: string, buildingIds: string[], extra: Partial<GroupTemplateInput['groups'][number]> = {}) => ({
  name,
  color: '#e6194b',
  target: 9,
  buildingIds,
  ...extra,
});

/** A tenancy as the tenant report left it, at a building. */
const tenancy = (
  building: { id: string; addressLine1: string; postalCode?: string; latitude?: number | null; longitude?: number | null; geocodePrecision?: string; geofence?: { latitude: number; longitude: number } | null },
  extra: { leaseName?: string; zone?: string; hvacPlan?: string; tbpEnrollment?: string; unitName?: string | null } = {},
) => ({
  leaseName: extra.leaseName ?? 'Tenant',
  zone: extra.zone ?? 'Zone 1',
  hvacPlan: extra.hvacPlan ?? 'On our AC Plan',
  tbpEnrollment: extra.tbpEnrollment ?? 'Yes',
  unitName: extra.unitName ?? null,
  building: {
    id: building.id,
    addressLine1: building.addressLine1,
    city: 'Houston',
    postalCode: building.postalCode ?? '77009',
    geocodePrecision: building.geocodePrecision ?? 'ROOFTOP',
    latitude: building.latitude === undefined ? 29.8 : building.latitude,
    longitude: building.longitude === undefined ? -95.39 : building.longitude,
    geofence: building.geofence ?? null,
  },
});

const build = (options: { tenancies?: ReturnType<typeof tenancy>[]; known?: number; claimed?: number; current?: { revision: number; archivedAt: Date | null } | null } = {}) => {
  const auditCreate = jest.fn().mockResolvedValue({});
  const templateUpdateMany = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 });
  const templateUpdate = jest.fn().mockResolvedValue({});
  const templateCreate = jest.fn().mockResolvedValue({});
  const groupCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const groupDeleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const memberCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const stored = {
    id: TEMPLATE,
    name: 'Outside in',
    isActive: false,
    minutesPerProperty: 30,
    revision: 2,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
    groups: [],
  };
  const client = {
    propertywareTenant: { findMany: jest.fn().mockResolvedValue(options.tenancies ?? []) },
    propertywareBuilding: { count: jest.fn().mockResolvedValue(options.known ?? 0) },
    tbpGroupTemplate: {
      findFirst: jest.fn(({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve(
          options.current === null
            ? null
            : 'groups' in select
              ? stored
              : { ...stored, ...(options.current ?? {}) },
        ),
      ),
      create: templateCreate,
      update: templateUpdate,
      updateMany: templateUpdateMany,
    },
    tbpGroupTemplateGroup: { createMany: groupCreateMany, deleteMany: groupDeleteMany },
    tbpGroupTemplateMember: { createMany: memberCreateMany },
    auditLog: { create: auditCreate },
  };
  const prisma = {
    ...client,
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  } as unknown as PrismaService;
  return {
    service: new GroupTemplateService(prisma),
    auditCreate,
    templateUpdateMany,
    templateUpdate,
    templateCreate,
    groupCreateMany,
    groupDeleteMany,
    memberCreateMany,
  };
};

describe('what a template may hold', () => {
  const valid: GroupTemplateInput = { name: 'Outside in', groups: [group('Group 1', ['b1', 'b2']), group('Group 2', ['b3'])] };

  it('takes groups of properties, each in one group', () => {
    expect(templateProblem(valid)).toBeNull();
  });

  it('refuses a property in two groups, saying which', () => {
    expect(templateProblem({ ...valid, groups: [group('North', ['b1']), group('South', ['b2', 'b1'])] })).toBe(
      'One property is in both North and South; a property is in one group.',
    );
    expect(templateProblem({ ...valid, groups: [group('North', ['b1', 'b1'])] })).toBe('North lists one property twice.');
  });

  it('refuses a group no day could hold, a colour it cannot draw, and no name', () => {
    const many = Array.from({ length: 25 }, (_, index) => `b${index}`);
    expect(templateProblem({ ...valid, groups: [group('Big', many)] })).toMatch('a day holds at most 24');
    expect(templateProblem({ ...valid, groups: [group('Red', ['b1'], { color: 'red' })] })).toMatch('#rrggbb');
    expect(templateProblem({ ...valid, name: '  ' })).toBe('Give the template a name.');
  });
});

describe('the Group maker’s properties', () => {
  it('is every enrolled building with a position, its tenancies together', async () => {
    const main = { id: 'b-main', addressLine1: '1 Main St' };
    const { service } = build({
      tenancies: [
        tenancy(main, { leaseName: 'Smith', unitName: 'House' }),
        tenancy(main, { leaseName: 'Jones', unitName: '1/2', zone: 'Zone 1' }),
        tenancy({ id: 'b-oak', addressLine1: '2 Oak St' }, { tbpEnrollment: 'No' }),
        tenancy({ id: 'b-elm', addressLine1: '3 Elm St' }, { tbpEnrollment: 'Not Verified' }),
        tenancy({ id: 'b-none', addressLine1: '4 Nowhere Rd', latitude: null, longitude: null }),
      ],
    });

    const { properties, withoutPosition } = await service.properties(ORG);

    expect(properties).toEqual([
      expect.objectContaining({
        buildingId: 'b-main',
        address: '1 Main St',
        zone: '1',
        leases: ['Smith', 'Jones'],
        units: ['House', '1/2'],
        approximate: false,
      }),
    ]);
    expect(withoutPosition).toBe(1);
  });

  it('draws a postcode-centre geocode as approximate, unless somebody corrected it on the ground', async () => {
    const { service } = build({
      tenancies: [
        tenancy({ id: 'b-1', addressLine1: '1 Main St', geocodePrecision: 'CENTROID' }),
        tenancy({ id: 'b-2', addressLine1: '2 Main St', geocodePrecision: 'CENTROID', geofence: { latitude: 29.81, longitude: -95.4 } }),
      ],
    });

    const { properties } = await service.properties(ORG);

    expect(properties.map((property) => [property.buildingId, property.approximate])).toEqual([
      ['b-1', true],
      ['b-2', false],
    ]);
  });

  it('matches a file’s rows to them by address, and leaves a row two buildings answer to', async () => {
    const { service } = build({
      tenancies: [
        tenancy({ id: 'b-main', addressLine1: '7 N Main St', postalCode: '77009' }),
        tenancy({ id: 'b-oak-1', addressLine1: '10 Oak Ln', postalCode: '77008' }),
        tenancy({ id: 'b-oak-2', addressLine1: '10 Oak Ln', postalCode: '77008' }),
      ],
    });

    const { matches } = await service.match(ORG, [
      { address: '7 North Main Street', postalCode: '77009-1234' },
      { address: '10 Oak Ln', postalCode: '77008' },
      { address: '99 Gone Ave', postalCode: '77001' },
    ]);

    expect(matches).toEqual([
      { buildingId: 'b-main', outcome: 'MATCHED' },
      { buildingId: null, outcome: 'AMBIGUOUS' },
      { buildingId: null, outcome: 'NONE' },
    ]);
  });
});

describe('saving a template', () => {
  const input: GroupTemplateInput = {
    name: 'Outside in',
    groups: [group('Group 1', ['b2', 'b1']), group('Group 2', ['b3'])],
    revision: 2,
  };

  it('writes each group and its properties in the order drawn, and audits counts, never addresses', async () => {
    const { service, groupCreateMany, memberCreateMany, groupDeleteMany, auditCreate } = build({ known: 3 });

    await service.save(user, TEMPLATE, input);

    expect(groupDeleteMany).toHaveBeenCalledWith({ where: { templateId: TEMPLATE, organizationId: ORG } });
    const groups = groupCreateMany.mock.calls[0][0].data;
    expect(groups.map((row: { position: number; name: string }) => [row.position, row.name])).toEqual([
      [1, 'Group 1'],
      [2, 'Group 2'],
    ]);
    const members = memberCreateMany.mock.calls[0][0].data;
    expect(members.map((row: { buildingId: string; position: number; groupId: string }) => [row.buildingId, row.position, row.groupId])).toEqual([
      ['b2', 1, groups[0].id],
      ['b1', 2, groups[0].id],
      ['b3', 1, groups[1].id],
    ]);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      action: 'TBP_GROUP_TEMPLATE_SAVED',
      entityId: TEMPLATE,
      metadata: { name: 'Outside in', revision: 3, groups: 2, properties: 3 },
    });
  });

  it('refuses a save over somebody else’s newer one, and writes no group', async () => {
    const { service, groupCreateMany } = build({ known: 3, claimed: 0, current: { revision: 3, archivedAt: null } });

    await expect(service.save(user, TEMPLATE, input)).rejects.toMatchObject({ code: 'TEMPLATE_CHANGED' });
    expect(groupCreateMany).not.toHaveBeenCalled();
  });

  it('refuses a change to an archived template', async () => {
    const { service } = build({ known: 3, claimed: 0, current: { revision: 2, archivedAt: new Date() } });

    await expect(service.save(user, TEMPLATE, input)).rejects.toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
  });

  it('refuses a property that is not this organization’s', async () => {
    const { service, templateUpdateMany } = build({ known: 2 });

    await expect(service.save(user, TEMPLATE, input)).rejects.toMatchObject({ code: 'UNKNOWN_PROPERTY' });
    expect(templateUpdateMany).not.toHaveBeenCalled();
  });

  it('creates a new one inactive', async () => {
    const { service, templateCreate, auditCreate } = build({ known: 3 });

    await service.create(user, { name: ' Outside in ', groups: input.groups });

    expect(templateCreate.mock.calls[0][0].data).toMatchObject({ organizationId: ORG, name: 'Outside in', createdById: 'user-1' });
    expect(templateCreate.mock.calls[0][0].data.isActive).toBeUndefined();
    expect(auditCreate.mock.calls[0][0].data.action).toBe('TBP_GROUP_TEMPLATE_CREATED');
  });
});

describe('the active template', () => {
  it('is one at a time: making one active makes the one before it inactive', async () => {
    const { service, templateUpdateMany, templateUpdate, auditCreate } = build();

    await service.setActive(user, TEMPLATE, true);

    expect(templateUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, isActive: true, NOT: { id: TEMPLATE } },
      data: { isActive: false },
    });
    expect(templateUpdate).toHaveBeenCalledWith({ where: { id: TEMPLATE }, data: { isActive: true } });
    expect(auditCreate.mock.calls[0][0].data.action).toBe('TBP_GROUP_TEMPLATE_ACTIVATED');
  });

  it('is never an archived one', async () => {
    const { service, templateUpdate } = build({ current: { revision: 2, archivedAt: new Date() } });

    await expect(service.setActive(user, TEMPLATE, true)).rejects.toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
    expect(templateUpdate).not.toHaveBeenCalled();
  });

  it('stops being active when archived', async () => {
    const { service, templateUpdateMany } = build();

    await service.archive(user, TEMPLATE);

    expect(templateUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: TEMPLATE, organizationId: ORG, archivedAt: null },
      data: { isActive: false },
    });
  });
});

describe('a template, read', () => {
  it('names every member by address, so a property no longer in the package can be named', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'template-1',
      name: 'Outside in',
      groups: [
        {
          id: 'group-1',
          position: 1,
          name: 'Group 4',
          color: '#e6194b',
          target: 9,
          members: [
            { buildingId: 'b1', building: { addressLine1: ' 1 Main St ', name: 'Main' } },
            { buildingId: 'b2', building: { addressLine1: null, name: 'The Oaks' } },
          ],
        },
      ],
    });
    const service = new GroupTemplateService({ tbpGroupTemplate: { findFirst } } as unknown as PrismaService);

    const template = await service.get('org-1', 'template-1');

    expect(template.groups[0]).toMatchObject({ name: 'Group 4', buildingIds: ['b1', 'b2'] });
    expect(template.addresses).toEqual({ b1: '1 Main St', b2: 'The Oaks' });
  });
});
