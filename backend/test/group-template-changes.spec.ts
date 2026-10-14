import type { PrismaService } from '../src/common/prisma.service';
import type { MapboxDirectionsClient } from '../src/routing/mapbox-directions.client';
import { GroupTemplateChangesService, packageStanding } from '../src/planning/group-template-changes.service';
import type { GroupMakerProperty, GroupTemplateService } from '../src/planning/group-template.service';

/**
 * What changed in the benefit package under a group template (the office,
 * 2026-10-15): "we should have a way to know if a property has opted out or
 * left the TBP ... where was that, what group", and for one that joined, "a
 * suggestion where or what group we can let it grouped based on the driving
 * time".
 */

const ORG = 'org-1';
const TEMPLATE = '6f0c1d2e-0000-4000-8000-000000000001';

const tenancy = (extra: Partial<{ isActive: boolean; tbpEnrollment: string | null; zone: string | null; deactivatedAt: Date | null }> = {}) => ({
  isActive: true,
  tbpEnrollment: 'Yes',
  zone: 'Zone 1',
  deactivatedAt: null,
  ...extra,
});

describe('why a property is no longer in the package', () => {
  it('names the office’s own switch first, with when and who', () => {
    const at = new Date('2026-10-14T15:00:00Z');
    const standing = packageStanding(
      { managementEndedAt: null, tbpOptedOutAt: at, managementEndedBy: null, tbpOptedOutBy: { displayName: 'Erika' } },
      [tenancy()],
    );
    expect(standing.inPackage).toBe(false);
    expect(standing.reasons).toEqual([{ code: 'OPTED_OUT', since: at.toISOString(), by: 'Erika', detail: null }]);
  });

  it('puts a management that ended before an opt-out', () => {
    const at = new Date('2026-10-13T15:00:00Z');
    const standing = packageStanding(
      { managementEndedAt: at, tbpOptedOutAt: at, managementEndedBy: { displayName: 'Ann' }, tbpOptedOutBy: { displayName: 'Ann' } },
      [tenancy()],
    );
    expect(standing.reasons.map((reason) => reason.code)).toEqual(['MANAGEMENT_ENDED', 'OPTED_OUT']);
  });

  it('says what the tenant report says instead of Yes', () => {
    const standing = packageStanding(null, [tenancy({ tbpEnrollment: 'No' }), tenancy({ tbpEnrollment: 'Not Verified' })]);
    expect(standing).toEqual({
      inPackage: false,
      reasons: [{ code: 'NOT_ENROLLED', since: null, by: null, detail: 'No, Not Verified' }],
    });
  });

  it('says when its tenancies are in a zone the package does not cover', () => {
    expect(packageStanding(null, [tenancy({ zone: 'Zone 5' })]).reasons).toEqual([
      { code: 'ZONE_EXCLUDED', since: null, by: null, detail: 'Zone 5' },
    ]);
  });

  it('dates a property whose last lease left the report by the last one to go', () => {
    const standing = packageStanding(null, [
      tenancy({ isActive: false, deactivatedAt: new Date('2026-09-01T08:00:00Z') }),
      tenancy({ isActive: false, deactivatedAt: new Date('2026-10-02T08:00:00Z') }),
    ]);
    expect(standing.reasons).toEqual([
      { code: 'NO_ACTIVE_LEASE', since: '2026-10-02T08:00:00.000Z', by: null, detail: null },
    ]);
  });

  it('is in the package with one enrolled tenancy in a covered zone, whatever its others say', () => {
    expect(packageStanding(null, [tenancy({ tbpEnrollment: 'No' }), tenancy()])).toEqual({ inPackage: true, reasons: [] });
  });
});

/** A property the Group maker draws, at a point along one east-west street. */
const property = (buildingId: string, longitude: number): GroupMakerProperty => ({
  buildingId,
  address: `${buildingId} Main St`,
  city: 'Houston',
  postalCode: '77009',
  latitude: 29.8,
  longitude,
  approximate: false,
  zone: '1',
  hvacPlans: [],
  leases: [],
  units: [],
});

const member = (buildingId: string) => ({ buildingId, building: { addressLine1: `${buildingId} Main St`, name: buildingId } });

const build = (options: { matrix?: (points: { latitude: number; longitude: number }[]) => number[][] | null; template?: unknown } = {}) => {
  const template =
    options.template === undefined
      ? {
          id: TEMPLATE,
          revision: 7,
          groups: [
            // West: A and B, and L who opted out.
            { id: 'g-west', position: 1, name: 'Group 1', color: '#e6194b', target: 10, members: [member('A'), member('B'), member('L')] },
            // East: C and D, and U, in the package with no position yet.
            { id: 'g-east', position: 2, name: 'Group 2', color: '#3cb44b', target: 2, members: [member('C'), member('D'), member('U')] },
          ],
        }
      : options.template;
  const findTemplate = jest.fn().mockResolvedValue(template);
  const findBuildings = jest.fn().mockResolvedValue([
    {
      id: 'L',
      serviceStatus: {
        managementEndedAt: null,
        tbpOptedOutAt: new Date('2026-10-14T15:00:00Z'),
        managementEndedBy: null,
        tbpOptedOutBy: { displayName: 'Erika' },
      },
    },
    { id: 'U', serviceStatus: null },
  ]);
  const findTenancies = jest.fn().mockImplementation(({ where }: { where: { isActive?: boolean } }) =>
    Promise.resolve(
      where.isActive
        ? // The newcomer's enrolled tenancies, for when it was first on the report.
          [
            { propertywareBuildingId: 'N', tbpEnrollment: 'Yes', zone: 'Zone 1', firstSyncedAt: new Date('2026-10-12T08:00:00Z') },
            { propertywareBuildingId: 'N', tbpEnrollment: 'Yes', zone: 'Zone 1', firstSyncedAt: new Date('2026-10-13T08:00:00Z') },
          ]
        : [
            { propertywareBuildingId: 'L', ...tenancy() },
            { propertywareBuildingId: 'U', ...tenancy() },
          ],
    ),
  );
  const prisma = {
    tbpGroupTemplate: { findFirst: findTemplate },
    propertywareBuilding: { findMany: findBuildings },
    propertywareTenant: { findMany: findTenancies },
  } as unknown as PrismaService;
  const templates = {
    properties: jest.fn().mockResolvedValue({
      // N is new, between B (west) and C (east), much nearer the west.
      properties: [property('A', -95.4), property('B', -95.39), property('C', -95.3), property('D', -95.29), property('N', -95.385)],
      withoutPosition: 1,
    }),
  } as unknown as GroupTemplateService;
  const matrix = jest.fn().mockImplementation((points: { latitude: number; longitude: number }[]) => {
    const durations = options.matrix ? options.matrix(points) : null;
    return Promise.resolve(durations ? { durations, distances: durations } : null);
  });
  const mapbox = { matrix } as unknown as MapboxDirectionsClient;
  return { service: new GroupTemplateChangesService(prisma, templates, mapbox), findTemplate, matrix };
};

describe('what changed under a template', () => {
  it('lists a property that left with the group it is still in and why', async () => {
    const { service } = build();
    const changes = await service.changes(ORG, TEMPLATE);
    expect(changes.leavers).toEqual([
      {
        buildingId: 'L',
        address: 'L Main St',
        group: { id: 'g-west', position: 1, name: 'Group 1', color: '#e6194b' },
        reasons: [{ code: 'OPTED_OUT', since: '2026-10-14T15:00:00.000Z', by: 'Erika', detail: null }],
      },
    ]);
  });

  it('keeps a member still in the package but with no position apart: it has not left', async () => {
    const { service } = build();
    const changes = await service.changes(ORG, TEMPLATE);
    expect(changes.unplaced).toEqual([
      { buildingId: 'U', address: 'U Main St', group: { id: 'g-east', position: 2, name: 'Group 2', color: '#3cb44b' } },
    ]);
  });

  it('offers a newcomer the groups it adds least driving to, nearest first, estimated when no router answers', async () => {
    const { service } = build();
    const [newcomer, ...others] = (await service.changes(ORG, TEMPLATE)).newcomers;
    expect(others).toEqual([]);
    expect(newcomer).toMatchObject({ buildingId: 'N', address: 'N Main St', zone: '1', firstOnReport: '2026-10-12T08:00:00.000Z' });
    expect(newcomer!.suggestions.map((suggestion) => suggestion.group.name)).toEqual(['Group 1', 'Group 2']);
    expect(newcomer!.suggestions[0]).toMatchObject({ members: 2, target: 10, hasRoom: true, timing: 'ESTIMATE' });
    expect(newcomer!.suggestions[0]!.nearest?.address).toBe('B Main St');
    // Group 2 is at its target of 2: offered, and said to be full.
    expect(newcomer!.suggestions[1]).toMatchObject({ members: 2, target: 2, hasRoom: false });
  });

  it('times the suggestions on the road when Mapbox answers', async () => {
    // Ten minutes between every two different points.
    const { service, matrix } = build({ matrix: (points) => points.map((_, from) => points.map((__, to) => (from === to ? 0 : 600))) });
    const [newcomer] = (await service.changes(ORG, TEMPLATE)).newcomers;
    expect(matrix).toHaveBeenCalled();
    // The newcomer itself is the first point of every matrix asked for.
    expect(matrix.mock.calls[0]![0][0]).toEqual({ latitude: 29.8, longitude: -95.385 });
    for (const suggestion of newcomer!.suggestions) {
      expect(suggestion.timing).toBe('ROAD');
      // In at either end: one ten-minute leg. Between two: ten in, ten on, less the ten it replaces.
      expect(suggestion.addedMinutes).toBe(10);
      expect(suggestion.nearest?.minutes).toBe(10);
    }
  });

  it('reads the template in the asker’s organization only, and says when there is none', async () => {
    const { service, findTemplate } = build({ template: null });
    await expect(service.changes(ORG, TEMPLATE)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    expect(findTemplate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: TEMPLATE, organizationId: ORG } }));
  });
});
