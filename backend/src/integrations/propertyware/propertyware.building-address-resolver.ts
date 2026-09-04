import { Inject, Injectable, Logger } from '@nestjs/common';

import { PORTFOLIO_VISIBLE } from '../../admin/inspection-creation';
import { PrismaService } from '../../common/prisma.service';
import {
  buildAddressIndex,
  buildLooseAddressIndex,
  looseAddressKey,
  matchBuildingWithFallback,
  normalizeAddressKey,
  normalizePostalCode,
} from '../jobber/jobber.address';

/**
 * Turns a building *address* into the external id the sync keys leases by.
 *
 * Needed because the lease report identifies its building by address and not by
 * id — Propertyware's report builder offers `Building Address` but no
 * `Building Entity ID` for this report. Without this the report cannot be tied
 * to a property at all, and leases stay empty.
 *
 * Uses the same matcher as the Jobber integration and the tenancy sync, so all
 * three resolve one property to the same building or to none. A second matcher
 * would let a lease and a visit disagree about where a property is, with
 * nothing to report the disagreement.
 */
@Injectable()
export class BuildingAddressResolver {
  private readonly logger = new Logger(BuildingAddressResolver.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Built per sync run and handed to the parser, rather than queried per row.
   *
   * 448 rows against 574 buildings is one read either way; per-row lookups
   * would be 448 of them.
   */
  async load(organizationId: string) {
    const buildings = await this.prisma.propertywareBuilding.findMany({
      where: { organizationId, isActive: true, ...PORTFOLIO_VISIBLE },
      select: { id: true, externalId: true, addressLine1: true, postalCode: true },
    });
    return new BuildingAddressIndex(buildings, this.logger);
  }
}

interface Candidate {
  id: string;
  externalId: string;
  addressLine1: string | null;
  postalCode: string | null;
}

export class BuildingAddressIndex {
  private readonly strict: Map<string, string[]>;
  private readonly loose: Map<string, string[]>;
  private readonly externalById: Map<string, string>;

  /**
   * Street without a postal code, for the report that has no ZIP column.
   *
   * A street alone is a weaker claim than street plus ZIP, so it is only
   * allowed to answer when exactly one building in the whole organization has
   * that street. Two properties at the same number on the same street name in
   * different towns is possible, and this refuses rather than picks one.
   */
  private readonly byStreetOnly: Map<string, string[]>;

  constructor(
    candidates: readonly Candidate[],
    private readonly logger: Logger,
  ) {
    this.strict = buildAddressIndex(candidates);
    this.loose = buildLooseAddressIndex(candidates);
    this.externalById = new Map(candidates.map((c) => [c.id, c.externalId]));

    this.byStreetOnly = new Map();
    for (const candidate of candidates) {
      // `normalizeAddressKey` needs a postal code to produce anything, so the
      // street half is taken from a key built with a constant stand-in.
      const key = normalizeAddressKey(candidate.addressLine1, '00000');
      if (!key) continue;
      const street = key.split('|')[0]!;
      const existing = this.byStreetOnly.get(street);
      if (existing) existing.push(candidate.id);
      else this.byStreetOnly.set(street, [candidate.id]);
    }
  }

  /**
   * The building's external id, or null when nothing answers unambiguously.
   *
   * Null is a real answer and not a failure: a lease at an address this system
   * does not hold is not a lease we can place, and guessing would file it
   * against somebody else's property.
   */
  resolve(addressLine1: string | null | undefined, postalCode?: string | null): string | null {
    if (!addressLine1?.trim()) return null;

    // With a ZIP, the ordinary matcher applies: exact key first, street-type
    // fallback second, both requiring exactly one building.
    if (normalizePostalCode(postalCode)) {
      const match = matchBuildingWithFallback(
        this.strict,
        this.loose,
        [normalizeAddressKey(addressLine1, postalCode)],
        looseAddressKey(addressLine1, postalCode),
      );
      return match.outcome === 'MATCHED' ? (this.externalById.get(match.buildingId) ?? null) : null;
    }

    const key = normalizeAddressKey(addressLine1, '00000');
    if (!key) return null;
    const candidates = this.byStreetOnly.get(key.split('|')[0]!);
    if (!candidates?.length) return null;
    if (candidates.length > 1) {
      // Recorded rather than silently dropped: a street shared by two buildings
      // is the one case where adding the ZIP column upstream would fix it.
      this.logger.warn({
        event: 'lease_address_ambiguous_without_postal_code',
        address: addressLine1,
        candidates: candidates.length,
      });
      return null;
    }
    return this.externalById.get(candidates[0]!) ?? null;
  }
}
