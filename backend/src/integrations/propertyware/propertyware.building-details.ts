import type { PropertyCustomField, PropertyDetailsSnapshot, PropertyManagerOnFile } from '@texasrenters/shared';

/**
 * A Propertyware building, as the REST API returns it, made into the snapshot
 * the property page shows (`PropertyDetailsSnapshot`).
 *
 * The building schema passes unknown fields through, and this reads them
 * defensively: every field is optional and checked for its type, because
 * Propertyware leaves most of them null, and one it renames or retypes must
 * blank that field rather than fail the building -- the sync's job is the
 * portfolio, and these are extras on it.
 *
 * Read from the list the sync already fetches, asked for with
 * `includeCustomFields=true`; no second request per building.
 */
export function buildingDetails(raw: Record<string, unknown>): PropertyDetailsSnapshot {
  const marketing = record(raw.marketing);
  const management = record(raw.management);
  return {
    building: {
      yearBuilt: positiveInteger(raw.yearBuilt),
      floors: positiveInteger(raw.numberFloors),
      bedrooms: positive(raw.numberOfBedrooms),
      bathrooms: positive(raw.numberOfBathrooms),
      neighborhood: text(raw.neighborhood),
      county: text(raw.county),
      parcelNumber: text(marketing.parcelNumber),
      amenities: list(raw.amenities)
        .map((amenity) => text(record(amenity).name))
        .filter((name): name is string => name !== null),
    },
    leasing: {
      status: text(raw.status),
      ready: flag(raw.ready),
      rentable: flag(raw.rentable),
      availableDate: day(marketing.availableDate),
      targetRent: positive(raw.targetRent),
      targetDeposit: positive(raw.targetDepositAmount) ?? positive(raw.targetDeposit),
      petsAllowed: flag(marketing.petsAllowed),
      smokingAllowed: flag(marketing.smokingAllowed),
      publishedForRent: flag(marketing.publishedForRent),
      postingTitle: text(marketing.postingTitle),
      description: text(marketing.shortDescription),
      comments: text(marketing.comments),
    },
    management: {
      contractStart: day(management.managementContractStartDate),
      contractEnd: day(management.managementContractEndDate),
      maintenanceLimit: positive(raw.maintenanceSpendingLimitAmount),
      maintenanceLimitPeriod: text(raw.maintenanceSpendingLimitTime),
      maintenanceNotice: text(raw.maintenanceNotice),
      managers: list(raw.propertyManagerList).flatMap((entry): PropertyManagerOnFile[] => {
        const manager = record(entry);
        const name = text(manager.name);
        return name ? [{ name, email: text(manager.email), role: text(manager.roleAsString) }] : [];
      }),
    },
    updated: { at: text(raw.lastModifiedDateTime), by: text(raw.lastModifiedBy) },
    customFields: list(raw.customFields).flatMap((entry): PropertyCustomField[] => {
      const field = record(entry);
      const name = text(field.fieldName);
      const value = text(field.value);
      return name && value ? [{ name, value }] : [];
    }),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
/** Propertyware writes 0 for "not set" on money and years; none of those is really zero. */
const positive = (value: unknown) => {
  const n = number(value);
  return n !== null && n > 0 ? n : null;
};
const positiveInteger = (value: unknown) => {
  const n = positive(value);
  return n === null ? null : Math.round(n);
};
/** "2026-10-01", from an ISO date or date-time; anything else is not a day. */
function day(value: unknown): string | null {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}
