import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { GroupTemplateGateway } from '../src/planning/group-template.gateway';
import { GroupTemplateService } from '../src/planning/group-template.service';

/**
 * Live group templates (the office, 2026-10-01): "if someone logged in and they
 * are working also for the same template I want to see the changes real time".
 */

const ORG = 'org-1';
const TEMPLATE = '6f0c1d2e-0000-4000-8000-000000000001';
const BATCH = '6f0c1d2e-0000-4000-8000-0000000000aa';
const G1 = '6f0c1d2e-0000-4000-8000-000000000011';
const G2 = '6f0c1d2e-0000-4000-8000-000000000012';
const B = (n: number) => `6f0c1d2e-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const user = { id: 'user-1', organizationId: ORG, principalType: 'USER', displayName: 'Ernie' } as unknown as AuthenticatedUser;

const build = (options: {
  groups?: { id: string; name: string; stops: string[] }[];
  claimed?: number;
  archived?: boolean;
  known?: number;
  recentAudit?: boolean;
  /** The active tenancies at the properties a change adds, as the zone check reads them. */
  tenancies?: { propertywareBuildingId: string; zone: string; tbpEnrollment: string }[];
} = {}) => {
  const groups = options.groups ?? [
    { id: G1, name: 'Group 1', stops: [B(1), B(2)] },
    { id: G2, name: 'Group 2', stops: [B(3)] },
  ];
  const templateUpdateMany = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 });
  const groupDeleteMany = jest.fn().mockResolvedValue({ count: groups.length });
  const groupCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const memberCreateMany = jest.fn().mockResolvedValue({ count: 0 });
  const auditCreate = jest.fn().mockResolvedValue({});
  const client = {
    tbpGroupTemplate: {
      updateMany: templateUpdateMany,
      findFirst: jest.fn(({ select }: { select: Record<string, unknown> }) =>
        Promise.resolve(
          'groups' in select
            ? {
                name: 'Outside in',
                revision: 5,
                groups: groups.map((group) => ({
                  id: group.id,
                  name: group.name,
                  color: '#e6194b',
                  target: 9,
                  members: group.stops.map((buildingId) => ({ buildingId })),
                })),
              }
            : { archivedAt: options.archived ? new Date() : null },
        ),
      ),
    },
    tbpGroupTemplateGroup: {
      deleteMany: groupDeleteMany,
      createMany: groupCreateMany,
      count: jest.fn().mockResolvedValue(0),
    },
    tbpGroupTemplateMember: { createMany: memberCreateMany },
    propertywareBuilding: { count: jest.fn().mockResolvedValue(options.known ?? 1) },
    propertywareTenant: { findMany: jest.fn().mockResolvedValue(options.tenancies ?? []) },
    auditLog: {
      findFirst: jest.fn().mockResolvedValue(options.recentAudit ? { id: 'audit-1' } : null),
      create: auditCreate,
    },
  };
  const prisma = { ...client, $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client) } as unknown as PrismaService;
  const live = { publishOps: jest.fn(), publishReplaced: jest.fn() };
  return {
    service: new GroupTemplateService(prisma, live as unknown as GroupTemplateGateway),
    live,
    templateUpdateMany,
    groupDeleteMany,
    groupCreateMany,
    memberCreateMany,
    auditCreate,
  };
};

describe('a batch of live edits', () => {
  it('is applied on top of what the template holds, every group keeping its id, and passed on', async () => {
    const { service, live, groupDeleteMany, groupCreateMany, memberCreateMany } = build();
    const ops = [{ type: 'stop.add', groupId: G2, stop: B(1) }];

    const result = await service.applyOps(user, TEMPLATE, BATCH, ops);

    expect(result).toEqual({ revision: 5 });
    expect(groupDeleteMany).toHaveBeenCalledWith({ where: { templateId: TEMPLATE, organizationId: ORG } });
    expect(groupCreateMany.mock.calls[0][0].data.map((row: { id: string; position: number }) => [row.id, row.position])).toEqual([
      [G1, 1],
      [G2, 2],
    ]);
    expect(
      memberCreateMany.mock.calls[0][0].data.map((row: { groupId: string; buildingId: string; position: number }) => [
        row.groupId,
        row.buildingId,
        row.position,
      ]),
    ).toEqual([
      [G1, B(2), 1],
      [G2, B(3), 1],
      [G2, B(1), 2],
    ]);
    expect(live.publishOps).toHaveBeenCalledWith({
      templateId: TEMPLATE,
      revision: 5,
      batchId: BATCH,
      ops,
      by: { userId: 'user-1', name: 'Ernie' },
    });
  });

  it('takes the template’s name and minutes per property from the batch, and locks the template to do it', async () => {
    const { service, templateUpdateMany } = build();

    await service.applyOps(user, TEMPLATE, BATCH, [{ type: 'template.update', name: ' Q1 grouping ', minutesPerProperty: 25 }]);

    expect(templateUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: TEMPLATE, organizationId: ORG, archivedAt: null },
      data: { revision: { increment: 1 }, name: 'Q1 grouping', minutesPerProperty: 25 },
    });
  });

  it('refuses what it cannot read, before anything is written', async () => {
    const { service, templateUpdateMany, live } = build();

    await expect(service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.add', groupId: G1, stop: 'not-an-id' }])).rejects.toMatchObject({
      code: 'INVALID_GROUP_TEMPLATE_OPS',
    });
    expect(templateUpdateMany).not.toHaveBeenCalled();
    expect(live.publishOps).not.toHaveBeenCalled();
  });

  it('refuses a change to an archived template', async () => {
    const { service, live } = build({ claimed: 0, archived: true });

    await expect(service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.remove', stop: B(1) }])).rejects.toMatchObject({
      code: 'TEMPLATE_ARCHIVED',
    });
    expect(live.publishOps).not.toHaveBeenCalled();
  });

  it('refuses a property that is not the organization’s', async () => {
    const { service, groupDeleteMany } = build({ known: 0 });

    await expect(service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.add', groupId: G1, stop: B(9) }])).rejects.toMatchObject({
      code: 'UNKNOWN_PROPERTY',
    });
    expect(groupDeleteMany).not.toHaveBeenCalled();
  });

  /** Zone 5 is not part of the benefit package (the office, 2026-10-02): none of its properties joins a template. */
  it('refuses a property in zone 5', async () => {
    const { service, groupDeleteMany } = build({
      tenancies: [{ propertywareBuildingId: B(9), zone: 'Zone 5', tbpEnrollment: 'Yes' }],
    });

    await expect(service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.add', groupId: G1, stop: B(9) }])).rejects.toMatchObject({
      code: 'NOT_IN_PACKAGE_ZONE',
    });
    expect(groupDeleteMany).not.toHaveBeenCalled();
  });

  it('refuses what would leave a group past a day’s stops', async () => {
    const full = Array.from({ length: 24 }, (_, index) => B(index + 10));
    const { service } = build({ groups: [{ id: G1, name: 'Group 1', stops: full }], known: 1 });

    await expect(service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.add', groupId: G1, stop: B(1) }])).rejects.toMatchObject({
      code: 'INVALID_GROUP_TEMPLATE',
    });
  });

  it('writes one audit row per person per ten minutes of editing, however many clicks', async () => {
    const first = build();
    await first.service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.remove', stop: B(1) }]);
    expect(first.auditCreate.mock.calls[0][0].data).toMatchObject({ action: 'TBP_GROUP_TEMPLATE_EDITED', entityId: TEMPLATE });

    const later = build({ recentAudit: true });
    await later.service.applyOps(user, TEMPLATE, BATCH, [{ type: 'stop.remove', stop: B(1) }]);
    expect(later.auditCreate).not.toHaveBeenCalled();
  });
});

describe('the live channel', () => {
  const socket = (organizationId = ORG) => {
    const data: Record<string, unknown> = {
      user: { id: 'user-1', organizationId, displayName: 'Ernie', permissions: ['planning:read'] },
    };
    return { data, join: jest.fn(), leave: jest.fn(), disconnected: false };
  };
  const gatewayWith = (template: { id: string; revision: number } | null, sockets: unknown[] = []) => {
    const findFirst = jest.fn().mockResolvedValue(template);
    const prisma = { tbpGroupTemplate: { findFirst } } as unknown as PrismaService;
    const gateway = new GroupTemplateGateway(prisma);
    const emit = jest.fn();
    Object.assign(gateway, {
      server: { in: () => ({ fetchSockets: async () => sockets }), to: jest.fn(() => ({ emit })) },
    });
    return { gateway, emit, findFirst };
  };

  it('opens a template of the account’s own organization, and says who has it open', async () => {
    const client = socket();
    const { gateway, emit, findFirst } = gatewayWith({ id: TEMPLATE, revision: 5 }, [client]);

    const answer = await gateway.join(client as never, { templateId: TEMPLATE });

    expect(answer).toEqual({ ok: true, revision: 5 });
    expect(findFirst.mock.calls[0][0].where).toEqual({ id: TEMPLATE, organizationId: ORG });
    expect(client.join).toHaveBeenCalledWith(`group-template:${TEMPLATE}`);
    expect(emit).toHaveBeenCalledWith('presence', {
      templateId: TEMPLATE,
      editors: [{ userId: 'user-1', name: 'Ernie', groupId: null }],
    });
  });

  it('refuses a template it cannot find for the account, and anything that is not an id', async () => {
    const client = socket();
    const { gateway } = gatewayWith(null);

    expect(await gateway.join(client as never, { templateId: TEMPLATE })).toEqual({ ok: false });
    expect(await gateway.join(client as never, { templateId: '../../etc' })).toEqual({ ok: false });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('shows a person with two tabs open once', async () => {
    const one = socket();
    const two = socket();
    two.data.groupId = G1;
    const { gateway, emit } = gatewayWith({ id: TEMPLATE, revision: 5 }, [one, two]);

    await gateway.join(one as never, { templateId: TEMPLATE });

    expect(emit.mock.calls.at(-1)![1].editors).toEqual([{ userId: 'user-1', name: 'Ernie', groupId: G1 }]);
  });
});
