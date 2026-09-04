import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  buildAddressIndex,
  buildLooseAddressIndex,
  looseAddressKey,
  matchBuildingWithFallback,
  normalizeAddressKey,
} from '../jobber/jobber.address';
import { PORTFOLIO_VISIBLE } from '../../admin/inspection-creation';
import { PrismaService } from '../../common/prisma.service';
import { getPropertywareConfig } from './propertyware.config';
import { PropertywareError } from './propertyware.errors';
import { parseTenantReport, type TenantReportRow } from './propertyware.tenant-report';

export interface TenantSyncResult {
  fetched: number;
  created: number;
  updated: number;
  matchedToBuilding: number;
  unmatchedAddress: number;
  deactivated: number;
}

/**
 * Brings the office's tenancy report into this system.
 *
 * The report is the only source that knows about the Tenant Benefit Package,
 * and the only one carrying a building address — which is what lets a tenancy
 * be tied to a property at all.
 *
 * Addresses are matched with the *same* matcher the Jobber integration uses,
 * deliberately. Two systems describing one property must resolve to the same
 * building or to neither; a second, subtly different matcher would produce a
 * tenant list and a visit list that disagree about where a property is, and
 * nothing would report the disagreement.
 */
@Injectable()
export class PropertywareTenantSyncService {
  private readonly logger = new Logger(PropertywareTenantSyncService.name);
  private readonly config = getPropertywareConfig();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async sync(organizationId: string): Promise<TenantSyncResult> {
    if (!this.config.tenantReportUrl)
      throw new PropertywareError(
        'No tenant report is configured. Set PROPERTYWARE_TENANT_REPORT_URL to the published report URL.',
        'PROPERTYWARE_TENANT_REPORT_NOT_CONFIGURED',
      );

    const response = await fetch(this.config.tenantReportUrl);
    if (!response.ok)
      throw new PropertywareError(
        `The Propertyware tenant report answered ${response.status}.`,
        'PROPERTYWARE_TENANT_REPORT_UNAVAILABLE',
        response.status,
      );
    const rows = parseTenantReport(await response.json());

    return this.apply(organizationId, rows);
  }

  /**
   * Separate from the fetch so it can be tested, and re-run over rows that came
   * from anywhere. Nothing here talks to Propertyware.
   */
  async apply(organizationId: string, rows: TenantReportRow[]): Promise<TenantSyncResult> {
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId, isActive: true, ...PORTFOLIO_VISIBLE },
      select: { id: true, addressLine1: true, postalCode: true },
    });
    const strict = buildAddressIndex(buildings);
    const loose = buildLooseAddressIndex(buildings);

    const result: TenantSyncResult = {
      fetched: rows.length,
      created: 0,
      updated: 0,
      matchedToBuilding: 0,
      unmatchedAddress: 0,
      deactivated: 0,
    };
    const seenAt = new Date();
    const seen: string[] = [];

    for (const row of rows) {
      const match = matchBuildingWithFallback(
        strict,
        loose,
        [normalizeAddressKey(row.addressLine1, row.postalCode)],
        looseAddressKey(row.addressLine1, row.postalCode),
      );
      const buildingId = match.outcome === 'MATCHED' ? match.buildingId : null;
      if (buildingId) result.matchedToBuilding += 1;
      else result.unmatchedAddress += 1;

      const data = {
        leaseName: row.leaseName,
        sourceStatus: row.sourceStatus,
        startDate: row.startDate ? new Date(row.startDate) : null,
        endDate: row.endDate ? new Date(row.endDate) : null,
        tbpEnrollment: row.tbpEnrollment,
        zone: row.zone,
        managementPlan: row.managementPlan,
        hvacPlan: row.hvacPlan,
        hvacFilterLocation: row.hvacFilterLocation,
        hvacFilterSizes: row.hvacFilterSizes,
        lastFilterDelivery: row.lastFilterDelivery,
        lastHvacInspection: row.lastHvacInspection ? new Date(row.lastHvacInspection) : null,
        lastOccupiedInspection: row.lastOccupiedInspection,
        addressLine1: row.addressLine1,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        propertywareBuildingId: buildingId,
        isActive: true,
        deactivatedAt: null,
        lastSyncedAt: seenAt,
        lastSeenAt: seenAt,
      };

      const existing = await this.prisma.propertywareTenant.findUnique({
        where: { organizationId_externalId: { organizationId, externalId: row.externalId } },
        select: { id: true },
      });
      await this.prisma.propertywareTenant.upsert({
        where: { organizationId_externalId: { organizationId, externalId: row.externalId } },
        create: { organizationId, externalId: row.externalId, ...data },
        update: data,
      });
      if (existing) result.updated += 1;
      else result.created += 1;
      seen.push(row.externalId);
    }

    /**
     * Tenancies the report no longer lists.
     *
     * Guarded the same way the Propertyware reconciliation sweep is, and for
     * the same reason: an empty report is a broken fetch, not every tenancy in
     * the portfolio ending at once. Deactivating on an empty result would empty
     * the tenant list in one pass and no later run would bring it back.
     */
    if (seen.length > 0) {
      const { count } = await this.prisma.propertywareTenant.updateMany({
        where: { organizationId, isActive: true, externalId: { notIn: seen } },
        data: { isActive: false, deactivatedAt: seenAt, lastSyncedAt: seenAt },
      });
      result.deactivated = count;
    }

    this.logger.log({ event: 'propertyware_tenant_sync_completed', organizationId, ...result });
    return result;
  }
}
