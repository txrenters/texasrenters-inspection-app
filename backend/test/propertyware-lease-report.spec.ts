import {
  leaseReportExternalId,
  reportDate,
} from '../src/integrations/propertyware/propertyware.client';
import { getPropertywareConfig } from '../src/integrations/propertyware/propertyware.config';
import { mapLease } from '../src/integrations/propertyware/propertyware.mapper';
import {
  propertywareLeaseReportSchema,
  propertywareSchemas,
} from '../src/integrations/propertyware/propertyware.schemas';

/** One row shaped exactly like the live published report. */
const ROW = {
  '0': 'Active - Notice Given',
  '1': '5',
  '2': '15691389',
  '3': '1521A',
  '4': 'Anderson - Johnston',
  '5': '10/11/2025',
  '6': '07/22/2026',
  '7': '05/20/2026',
  '8': 'Blackbird LLC',
  '9': '5019697154',
  '10': '1521A Creekside Ln, Nacogdoches, Texas 75964-2649',
};

describe('Propertyware lease report fallback', () => {
  it('accepts the live report envelope', () => {
    const parsed = propertywareLeaseReportSchema.safeParse({
      totalCount: 1,
      columns: [{ index: '0', dataType: 'text', label: 'Status' }],
      records: [ROW],
    });
    expect(parsed.success).toBe(true);
  });

  it('derives the same key every run, so re-syncing updates instead of duplicating', () => {
    const first = leaseReportExternalId(ROW['9'], ROW['4'], ROW['5']);
    const second = leaseReportExternalId(ROW['9'], ROW['4'], ROW['5']);

    expect(first).toBe(second);
    // Prefixed so it can never collide with a numeric REST lease ID if the
    // /leases permission is granted later.
    expect(first.startsWith('rpt-')).toBe(true);
    expect(first).not.toMatch(/^\d+$/);
  });

  it('keys distinct leases distinctly, including a second lease on one building', () => {
    const anderson = leaseReportExternalId('5019697154', 'Anderson - Johnston', '10/11/2025');
    const renewal = leaseReportExternalId('5019697154', 'Anderson - Johnston', '10/11/2026');
    const neighbour = leaseReportExternalId('5019697154', 'Charles - Martin', '10/11/2025');
    const otherBuilding = leaseReportExternalId('3583311878', 'Anderson - Johnston', '10/11/2025');

    expect(new Set([anderson, renewal, neighbour, otherBuilding]).size).toBe(4);
  });

  it('converts report dates to ISO and rejects anything else', () => {
    expect(reportDate('10/11/2025')).toBe('2025-10-11');
    expect(reportDate('07/22/2026')).toBe('2026-07-22');
    // Never guess at an unparseable or empty date.
    expect(reportDate('')).toBeUndefined();
    expect(reportDate('2025-10-11')).toBeUndefined();
    expect(reportDate(undefined)).toBeUndefined();
  });

  it('normalizes a report row into a building-linked lease with no unit', () => {
    const raw = propertywareSchemas.leases.parse({
      id: leaseReportExternalId(ROW['9'], ROW['4'], ROW['5']),
      buildingID: ROW['9'],
      leaseName: ROW['4'],
      active: true,
      status: ROW['0'],
      startDate: reportDate(ROW['5']),
      endDate: reportDate(ROW['6']),
      noticeGivenDate: reportDate(ROW['7']),
      contacts: [],
    });
    const lease = mapLease(raw);

    expect(lease.buildingExternalId).toBe('5019697154');
    expect(lease.endDate).toBe('2026-07-22');
    expect(lease.sourceStatus).toBe('Active - Notice Given');
    expect(lease.isActive).toBe(true);
    // No unit or portfolio column exists in the report; both are resolved from
    // the building at persist time rather than invented here.
    expect(lease.unitExternalId).toBeUndefined();
    expect(lease.portfolioExternalId).toBeUndefined();
    // Tenant names are never inferred from the lease name.
    expect(lease.tenantDisplayNames).toEqual([]);
  });

  it('still requires a unit on REST leases, which do carry one', () => {
    const lease = mapLease(
      propertywareSchemas.leases.parse({
        id: '900',
        portfolioID: '10',
        buildingID: '20',
        unitID: '30',
        active: true,
        contacts: [],
      }),
    );

    expect(lease.unitExternalId).toBe('30');
    expect(lease.portfolioExternalId).toBe('10');
  });

  it('pins report URLs to Propertyware so a stray value cannot leak the token', () => {
    const base = {
      PROPERTYWARE_PROVIDER: 'mock',
      PROPERTYWARE_LEASE_REPORT_URL: 'https://evil.example.com/pw/1/JSON',
    } as NodeJS.ProcessEnv;

    expect(() => getPropertywareConfig(base)).toThrow(/PROPERTYWARE_LEASE_REPORT_URL/);
    expect(() =>
      getPropertywareConfig({
        PROPERTYWARE_PROVIDER: 'mock',
        PROPERTYWARE_LEASE_REPORT_URL: 'http://app.propertyware.com/pw/1/JSON',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PROPERTYWARE_LEASE_REPORT_URL/);
    expect(
      getPropertywareConfig({
        PROPERTYWARE_PROVIDER: 'mock',
        PROPERTYWARE_LEASE_REPORT_URL: 'https://app.propertyware.com/pw/00a/1/JSON?tok',
      } as NodeJS.ProcessEnv).leaseReportUrl,
    ).toContain('app.propertyware.com');
  });
});
