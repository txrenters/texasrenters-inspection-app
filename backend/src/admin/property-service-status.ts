import type { PropertyServiceStatus } from '@texasrenters/shared';

/**
 * The office's switches on a property, as everything that books visits reads
 * them (`PropertyServiceStatus` in the schema; the office, 2026-10-08).
 *
 * Read through the building in the same query that finds the work -- a lease,
 * a tenancy -- rather than as a second lookup, so a property with no row reads
 * as both switches off without anyone having to ask.
 */
export const SERVICE_SWITCHES_SELECT = { managementEndedAt: true, tbpOptedOutAt: true } as const;

type Switches = { managementEndedAt?: Date | null; tbpOptedOutAt?: Date | null } | null | undefined;

/** The owner ended Texas Renters' management: nothing more is booked at the property. */
export const managementHasEnded = (switches: Switches) => Boolean(switches?.managementEndedAt);

/**
 * No more benefit-package visits: the property opted out of the package, or
 * left management altogether.
 */
export const leftBenefitPackage = (switches: Switches) =>
  Boolean(switches?.managementEndedAt || switches?.tbpOptedOutAt);

/** The switches as the console shows them, with who turned each on. */
export const SERVICE_STATUS_VIEW_SELECT = {
  managementEndedAt: true,
  tbpOptedOutAt: true,
  managementEndedBy: { select: { id: true, displayName: true } },
  tbpOptedOutBy: { select: { id: true, displayName: true } },
} as const;

interface StatusRow {
  managementEndedAt: Date | null;
  tbpOptedOutAt: Date | null;
  managementEndedBy: { id: string; displayName: string } | null;
  tbpOptedOutBy: { id: string; displayName: string } | null;
}

export function serviceStatusView(row: StatusRow | null | undefined): PropertyServiceStatus {
  return {
    managementEnded: row?.managementEndedAt
      ? { at: row.managementEndedAt.toISOString(), by: row.managementEndedBy }
      : null,
    tbpOptedOut: row?.tbpOptedOutAt ? { at: row.tbpOptedOutAt.toISOString(), by: row.tbpOptedOutBy } : null,
  };
}
