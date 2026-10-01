import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PropertyOwnerDetails } from '@texasrenters/shared';
import { z } from 'zod';

import { PrismaService } from '../../common/prisma.service';
import { reportDate } from './propertyware.client';
import { getPropertywareConfig } from './propertyware.config';
import { PropertywareError } from './propertyware.errors';
import { reportColumnIndexes } from './propertyware.schemas';

/**
 * The office's property-owner report: who owns each home, and their phones.
 *
 * Propertyware's REST API will not say (`/portfolios` is denied, `/owners`
 * does not exist), and the property page needed it (2026-10-01). The office
 * published a report with one row per building -- owners, their mobile and
 * home phones, the county, the date the first management agreement was signed
 * -- and this keeps it on each building as `ownerDetails`.
 *
 * Matched by Building Entity ID, which is the building's own Propertyware id:
 * no address matching, nothing to get wrong.
 */
const OWNER_REPORT_COLUMNS = { buildingExternalId: 'Building Entity ID' } as const;
const OWNER_REPORT_OPTIONAL_COLUMNS = {
  owners: 'Property Owners',
  portfolioName: 'Portfolio Name',
  mobilePhones: 'Property Owner Mobile Phones',
  homePhones: 'Property Owner Home Phones',
  managementAgreementSignedOn: 'Date 1st Mgmt Agreement Signed',
} as const;

/** Lenient where the lease report's schema is strict: an owner with no phone is an empty cell, not a broken row. */
const ownerReportSchema = z.object({
  columns: z.array(z.object({ index: z.string(), label: z.string() })),
  records: z.array(z.record(z.string(), z.unknown())),
});

export interface OwnerReportRow extends PropertyOwnerDetails {
  buildingExternalId: string;
}

export function parseOwnerReport(payload: unknown): OwnerReportRow[] {
  const report = ownerReportSchema.safeParse(payload);
  if (!report.success)
    throw new PropertywareError('Propertyware returned an unexpected owner report shape.', 'PROPERTYWARE_INVALID_OWNER_REPORT');
  const { indexes, optionalIndexes, missing } = reportColumnIndexes(
    report.data.columns,
    OWNER_REPORT_COLUMNS,
    OWNER_REPORT_OPTIONAL_COLUMNS,
  );
  if (missing.length)
    throw new PropertywareError(
      `The Propertyware owner report is missing ${missing.map((label) => `"${label}"`).join(', ')}.`,
      'PROPERTYWARE_OWNER_REPORT_MISSING_COLUMNS',
    );
  const cell = (record: Record<string, unknown>, index: string | undefined) => {
    if (index === undefined) return null;
    const value = record[index];
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    return text || null;
  };
  return report.data.records.flatMap((record) => {
    const buildingExternalId = cell(record, indexes.buildingExternalId);
    if (!buildingExternalId) return [];
    const signed = cell(record, optionalIndexes.managementAgreementSignedOn);
    return [
      {
        buildingExternalId,
        owners: cell(record, optionalIndexes.owners),
        portfolioName: cell(record, optionalIndexes.portfolioName),
        mobilePhones: cell(record, optionalIndexes.mobilePhones),
        homePhones: cell(record, optionalIndexes.homePhones),
        managementAgreementSignedOn: reportDate(signed ?? undefined) ?? signed,
      },
    ];
  });
}

export interface OwnerReportResult {
  fetched: number;
  updated: number;
  unmatched: number;
}

@Injectable()
export class PropertywareOwnerReportService {
  private readonly logger = new Logger(PropertywareOwnerReportService.name);
  private readonly config = getPropertywareConfig();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Null when no owner report is configured: it is an extra, not a requirement. */
  async sync(organizationId: string): Promise<OwnerReportResult | null> {
    if (!this.config.ownerReportUrl) return null;
    const response = await fetch(this.config.ownerReportUrl);
    if (!response.ok)
      throw new PropertywareError(
        `The Propertyware owner report answered ${response.status}.`,
        'PROPERTYWARE_OWNER_REPORT_UNAVAILABLE',
        response.status,
      );
    return this.apply(organizationId, parseOwnerReport(await response.json()));
  }

  /** Written only where it changed, so a nightly run of 438 rows writes the handful that did. */
  async apply(organizationId: string, rows: readonly OwnerReportRow[]): Promise<OwnerReportResult> {
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId, externalId: { in: rows.map((row) => row.buildingExternalId) } },
      select: { id: true, externalId: true, ownerDetails: true },
    });
    const byExternalId = new Map(buildings.map((building) => [building.externalId, building]));
    const result: OwnerReportResult = { fetched: rows.length, updated: 0, unmatched: 0 };
    for (const { buildingExternalId, ...owner } of rows) {
      const building = byExternalId.get(buildingExternalId);
      if (!building) {
        result.unmatched += 1;
        continue;
      }
      if (JSON.stringify(building.ownerDetails) === JSON.stringify(owner)) continue;
      await this.prisma.propertywareBuilding.update({
        where: { id: building.id },
        data: { ownerDetails: owner as unknown as Prisma.InputJsonValue },
      });
      result.updated += 1;
    }
    this.logger.log({ event: 'propertyware_owner_report_applied', ...result });
    return result;
  }
}
