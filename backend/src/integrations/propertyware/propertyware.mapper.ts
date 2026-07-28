import { createHash } from 'node:crypto';

import type {
  RawPropertywareBuilding,
  RawPropertywareLease,
  RawPropertywarePortfolio,
  RawPropertywareUnit,
} from './propertyware.schemas';
import type {
  NormalizedAddress,
  NormalizedBuilding,
  NormalizedLease,
  NormalizedPortfolio,
  NormalizedPropertywareRecord,
  NormalizedUnit,
} from './propertyware.types';

const id = (value: string | number) => String(value);
const value = (input?: string | null) => input?.trim() || undefined;

function address(input: RawPropertywareBuilding['address']): NormalizedAddress {
  return {
    addressLine1: value(input?.address),
    addressLine2: value(input?.addressCont),
    city: value(input?.city),
    state: value(input?.stateRegion),
    postalCode: value(input?.postalCode),
    country: value(input?.country),
  };
}

export function mapPortfolio(raw: RawPropertywarePortfolio): NormalizedPortfolio {
  return {
    entityType: 'portfolios',
    externalId: id(raw.id),
    name: raw.name.trim(),
    abbreviation: value(raw.abbreviation),
    isActive: raw.active,
    sourceStatus: raw.active ? 'Active' : 'Inactive',
    sourceCreatedAt: value(raw.createdDateTime),
    sourceUpdatedAt: value(raw.lastModifiedDateTime),
    owners: raw.owners.map((owner) => ({
      externalId: id(owner.id),
      displayName:
        value(owner.name) ??
        value([value(owner.firstName), value(owner.lastName)].filter(Boolean).join(' ')) ??
        `Owner ${id(owner.id)}`,
      percentageOwnership: owner.percentageOwnership ?? undefined,
      isActive: true,
    })),
  };
}

export function mapBuilding(raw: RawPropertywareBuilding): NormalizedBuilding {
  return {
    entityType: 'buildings',
    externalId: id(raw.id),
    portfolioExternalId: id(raw.portfolioID),
    idNumber: raw.idNumber == null ? undefined : id(raw.idNumber),
    name: raw.name.trim(),
    abbreviation: value(raw.abbreviation),
    propertyType: value(raw.propertyType) ?? value(raw.type),
    // Only carry a positive area; Propertyware reports 0 when unset.
    totalArea: raw.totalArea != null && raw.totalArea > 0 ? Math.round(raw.totalArea) : undefined,
    areaUnits: value(raw.areaUnits),
    category: value(raw.category),
    isActive: raw.active,
    sourceStatus: raw.status ?? (raw.active ? 'Active' : 'Inactive'),
    ...address(raw.address),
    sourceCreatedAt: value(raw.createdDateTime),
    sourceUpdatedAt: value(raw.lastModifiedDateTime),
  };
}

export function mapUnit(raw: RawPropertywareUnit): NormalizedUnit {
  return {
    entityType: 'units',
    externalId: id(raw.id),
    buildingExternalId: id(raw.buildingID),
    portfolioExternalId: id(raw.portfolioID),
    idNumber: raw.idNumber == null ? undefined : id(raw.idNumber),
    name: raw.name.trim(),
    abbreviation: value(raw.abbreviation),
    type: value(raw.type),
    vacant: raw.status ? raw.status.toLowerCase() === 'vacant' : undefined,
    publishedForRent: raw.syndicate ?? undefined,
    bedrooms: raw.numberOfBedrooms ?? undefined,
    bathrooms: raw.numberOfBathrooms ?? undefined,
    isActive: raw.active,
    sourceStatus: raw.status ?? (raw.active ? 'Active' : 'Inactive'),
    ...address(raw.address),
    sourceCreatedAt: value(raw.createdDateTime),
    sourceUpdatedAt: value(raw.lastModifiedDateTime),
  };
}

export function mapLease(raw: RawPropertywareLease): NormalizedLease {
  return {
    entityType: 'leases',
    externalId: id(raw.id),
    // Report-sourced leases carry neither; the portfolio is resolved from the
    // building at persist time and the unit link is left empty.
    portfolioExternalId: raw.portfolioID == null ? undefined : id(raw.portfolioID),
    buildingExternalId: id(raw.buildingID),
    unitExternalId: raw.unitID == null ? undefined : id(raw.unitID),
    idNumber: raw.idNumber == null ? undefined : id(raw.idNumber),
    leaseName: value(raw.leaseName),
    isActive: raw.active,
    sourceStatus: value(raw.status) ?? (raw.active ? 'Active' : 'Inactive'),
    startDate: value(raw.startDate),
    endDate: value(raw.endDate),
    moveInDate: value(raw.moveInDate),
    scheduledMoveOutDate: value(raw.scheduleMoveOutDate),
    moveOutDate: value(raw.moveOutDate),
    noticeGivenDate: value(raw.noticeGivenDate),
    reasonForLeaving: value(raw.reasonForLeaving),
    tenantDisplayNames: raw.contacts
      .map(
        (contact) =>
          value(contact.name) ??
          [value(contact.firstName), value(contact.lastName)].filter(Boolean).join(' '),
      )
      .filter((name): name is string => Boolean(name)),
    sourceCreatedAt: value(raw.createdDateTime),
    sourceUpdatedAt: value(raw.lastModifiedDateTime),
  };
}

export function stableSourceHash(record: NormalizedPropertywareRecord): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    return input;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(record)))
    .digest('hex');
}
