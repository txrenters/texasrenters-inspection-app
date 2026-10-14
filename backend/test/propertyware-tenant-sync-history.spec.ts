import { PropertywareTenantSyncService } from '../src/integrations/propertyware/propertyware.tenant-sync.service';
import type { TenantReportRow } from '../src/integrations/propertyware/propertyware.tenant-report';

/**
 * The nightly tenant report moves properties into and out of the benefit
 * package by overwriting a tenancy's enrolment in place. Since 2026-10-15 each
 * run records the difference, so a Yes that became a No leaves a trace. Places
 * invented.
 */

const ORG = 'org-1';

const row = (externalId: string, buildingExternalId: string, tbpEnrollment: string): TenantReportRow => ({
  externalId,
  buildingExternalId,
  leaseName: `Lease ${externalId}`,
  sourceStatus: 'Active',
  startDate: null,
  endDate: null,
  tbpEnrollment,
  zone: 'Zone 1',
  managementPlan: null,
  hvacPlan: null,
  hvacFilterLocation: null,
  hvacFilterSizes: [],
  lastFilterDelivery: null,
  lastHvacInspection: null,
  lastOccupiedInspection: null,
  addressLine1: null,
  city: null,
  state: null,
  postalCode: null,
  unitExternalId: null,
  unitName: null,
});

const tenancy = (buildingId: string, tbpEnrollment: string) => ({
  propertywareBuildingId: buildingId,
  isActive: true,
  tbpEnrollment,
  zone: 'Zone 1',
  deactivatedAt: null,
});

function build(membership: { before: unknown[]; after: unknown[] }) {
  const prisma = {
    propertywareBuilding: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'building-1', externalId: 'pw-1', addressLine1: '1 Oak St', postalCode: '77009' },
        { id: 'building-2', externalId: 'pw-2', addressLine1: '2 Elm St', postalCode: '77009' },
      ]),
    },
    propertywareTenant: {
      // The package as it stood before the run, then after it.
      findMany: jest.fn().mockResolvedValueOnce(membership.before).mockResolvedValue(membership.after),
      findUnique: jest.fn().mockResolvedValue({ id: 'existing' }),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    propertyServiceStatus: { findMany: jest.fn().mockResolvedValue([]) },
    tbpPackageChange: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
  };
  return { service: new PropertywareTenantSyncService(prisma as never), prisma };
}

describe('the tenant report’s run, as the benefit package’s history', () => {
  it('records the property whose Yes became a No as leaving, and the one that became a Yes as joining', async () => {
    const { service, prisma } = build({
      before: [tenancy('building-1', 'Yes'), tenancy('building-2', 'No')],
      after: [tenancy('building-1', 'No'), tenancy('building-2', 'Yes')],
    });

    const result = await service.apply(ORG, [row('t-1', 'pw-1', 'No'), row('t-2', 'pw-2', 'Yes')]);

    expect(result).toMatchObject({ fetched: 2, updated: 2, matchedToBuilding: 2 });
    expect(prisma.tbpPackageChange.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          organizationId: ORG,
          buildingId: 'building-1',
          kind: 'LEFT',
          source: 'TENANT_REPORT',
          reason: 'NOT_ENROLLED',
          detail: 'No',
          actorUserId: null,
        }),
        expect.objectContaining({ buildingId: 'building-2', kind: 'JOINED', source: 'TENANT_REPORT', reason: null }),
      ],
    });
  });

  it('records nothing for an empty report: that is a broken fetch, not every property leaving', async () => {
    const { service, prisma } = build({ before: [tenancy('building-1', 'Yes')], after: [] });

    await service.apply(ORG, []);

    expect(prisma.propertywareTenant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tbpPackageChange.createMany).not.toHaveBeenCalled();
  });

  it('still syncs when the history cannot be written', async () => {
    const { service, prisma } = build({ before: [tenancy('building-1', 'Yes')], after: [tenancy('building-1', 'No')] });
    prisma.tbpPackageChange.createMany.mockRejectedValue(new Error('pool exhausted'));

    await expect(service.apply(ORG, [row('t-1', 'pw-1', 'No')])).resolves.toMatchObject({ updated: 1 });
    expect(prisma.propertywareTenant.upsert).toHaveBeenCalled();
  });

  it('still syncs when the package cannot be read beforehand, and records nothing it cannot compare', async () => {
    const { service, prisma } = build({ before: [], after: [] });
    prisma.propertywareTenant.findMany.mockReset().mockRejectedValue(new Error('pool exhausted'));

    await expect(service.apply(ORG, [row('t-1', 'pw-1', 'No')])).resolves.toMatchObject({ updated: 1 });
    expect(prisma.tbpPackageChange.createMany).not.toHaveBeenCalled();
  });
});
