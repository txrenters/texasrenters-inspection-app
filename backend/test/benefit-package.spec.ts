import { packageMembership, packageStanding, recordPackageChanges, type PackageStanding } from '../src/common/benefit-package';
import type { PrismaService } from '../src/common/prisma.service';

/**
 * Whether a property is in the tenant benefit package, and the history of it
 * joining and leaving (the office, 2026-10-15): "we should have a way to know
 * if a property has opted out or left the TBP", and "if there's a new tbp ...
 * we should know also".
 */

const ORG = 'org-1';

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

describe('the package, read for a set of properties', () => {
  const client = (tenancies: unknown[], statuses: unknown[] = []) =>
    ({
      propertywareTenant: { findMany: jest.fn().mockResolvedValue(tenancies) },
      propertyServiceStatus: { findMany: jest.fn().mockResolvedValue(statuses) },
    }) as unknown as PrismaService & {
      propertywareTenant: { findMany: jest.Mock };
      propertyServiceStatus: { findMany: jest.Mock };
    };

  it('reads every property a tenancy is placed at, in the asker’s organization', async () => {
    const prisma = client([
      { propertywareBuildingId: 'A', ...tenancy() },
      { propertywareBuildingId: 'B', ...tenancy({ tbpEnrollment: 'No' }) },
    ]);

    const membership = await packageMembership(prisma, ORG);

    expect(prisma.propertywareTenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, propertywareBuildingId: { not: null } } }),
    );
    expect(prisma.propertyServiceStatus.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: ORG } }));
    expect(membership.get('A')).toEqual({ inPackage: true, reasons: [] });
    expect(membership.get('B')?.inPackage).toBe(false);
  });

  it('answers for every property named, one without tenancies included, and applies the office’s switches', async () => {
    const prisma = client(
      [{ propertywareBuildingId: 'A', ...tenancy() }],
      [{ buildingId: 'A', managementEndedAt: null, tbpOptedOutAt: new Date('2026-10-14T15:00:00Z'), managementEndedBy: null, tbpOptedOutBy: null }],
    );

    const membership = await packageMembership(prisma, ORG, ['A', 'Z']);

    expect(prisma.propertywareTenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, propertywareBuildingId: { in: ['A', 'Z'] } } }),
    );
    expect(membership.get('A')).toMatchObject({ inPackage: false, reasons: [{ code: 'OPTED_OUT' }] });
    expect(membership.get('Z')).toMatchObject({ inPackage: false, reasons: [{ code: 'NO_ACTIVE_LEASE', since: null }] });
  });
});

describe('the package’s history', () => {
  const inPackage: PackageStanding = { inPackage: true, reasons: [] };
  const out = (code: 'NOT_ENROLLED' | 'OPTED_OUT', detail: string | null = null): PackageStanding => ({
    inPackage: false,
    reasons: [{ code, since: null, by: null, detail }],
  });
  const AT = new Date('2026-10-15T08:00:00Z');
  const client = () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    return { prisma: { tbpPackageChange: { createMany } } as unknown as PrismaService, createMany };
  };

  it('writes a row for each property that joined or left, and none for the rest', async () => {
    const { prisma, createMany } = client();
    const before = new Map([
      ['stays', inPackage],
      ['leaves', inPackage],
      ['joins', out('NOT_ENROLLED', 'No')],
      ['stays-out', out('NOT_ENROLLED', 'No')],
    ]);
    const after = new Map([
      ['stays', inPackage],
      ['leaves', out('NOT_ENROLLED', 'Not Verified')],
      ['joins', inPackage],
      ['stays-out', out('NOT_ENROLLED', 'No')],
      // New on the report and enrolled at once.
      ['arrives', inPackage],
    ]);

    const counts = await recordPackageChanges(prisma, ORG, before, after, { source: 'TENANT_REPORT', at: AT });

    expect(counts).toEqual({ joined: 2, left: 1 });
    const common = { organizationId: ORG, source: 'TENANT_REPORT', actorUserId: null, actorName: null, occurredAt: AT };
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { ...common, buildingId: 'leaves', kind: 'LEFT', reason: 'NOT_ENROLLED', detail: 'Not Verified' },
        { ...common, buildingId: 'joins', kind: 'JOINED', reason: null, detail: null },
        { ...common, buildingId: 'arrives', kind: 'JOINED', reason: null, detail: null },
      ],
    });
  });

  it('counts a property its last tenancy moved away from as having left', async () => {
    const { prisma, createMany } = client();

    await recordPackageChanges(prisma, ORG, new Map([['moved', inPackage]]), new Map(), { source: 'TENANT_REPORT', at: AT });

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ buildingId: 'moved', kind: 'LEFT', reason: null })],
    });
  });

  it('names the person for the office’s own switch', async () => {
    const { prisma, createMany } = client();

    await recordPackageChanges(prisma, ORG, new Map([['A', inPackage]]), new Map([['A', out('OPTED_OUT')]]), {
      source: 'OFFICE',
      actor: { id: 'user-1', name: 'Pat Office' },
      at: AT,
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ kind: 'LEFT', source: 'OFFICE', reason: 'OPTED_OUT', actorUserId: 'user-1', actorName: 'Pat Office' })],
    });
  });

  it('writes nothing when nothing changed', async () => {
    const { prisma, createMany } = client();

    const counts = await recordPackageChanges(prisma, ORG, new Map([['A', inPackage]]), new Map([['A', inPackage]]), {
      source: 'TENANT_REPORT',
    });

    expect(counts).toEqual({ joined: 0, left: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });
});
