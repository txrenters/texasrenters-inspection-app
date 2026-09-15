import { parseVisitDetails, type VisitDetailsFilter } from '@texasrenters/shared';

/**
 * The Jobber visit's Details, as the phone shows them to the technician walking it.
 *
 * Kept apart from the card so the rules -- what to call a service, how a filter
 * reads, what a phone link dials -- can be tested without rendering anything.
 */
export interface VisitDetailsView {
  services: string[];
  /** Whether filters were booked at all, so "no sizes given" can be said. */
  filterChange: boolean;
  filters: string[];
  filterNotes: string[];
  contactBeforeArrival: boolean;
  tenants: {
    key: string;
    name: string;
    unit: string | null;
    phones: { display: string; dial: string }[];
  }[];
  accessNotes: string[];
  notes: string[];
  completionSteps: string[];
  /** The details say no occupied inspection is needed on this visit. */
  inspectionNotNeeded: boolean;
  raw: string;
}

export function visitDetailsView(text: string | null | undefined): VisitDetailsView | null {
  const read = parseVisitDetails(text);
  if (!read.raw) return null;
  return {
    services: [
      read.services.filterChange ? 'Filter change' : null,
      read.services.pestControl ? 'Pest control' : null,
      read.services.fleaTreatment ? 'Flea treatment' : null,
      read.services.occupiedInspection ? 'Occupied inspection' : null,
      ...read.services.other,
    ].filter((label): label is string => Boolean(label)),
    filterChange: read.services.filterChange,
    filters: read.filters.map(filterLine),
    filterNotes: read.filterNotes,
    contactBeforeArrival: read.contactTenantsBeforeArrival,
    tenants: read.tenants.map((tenant, index) => ({
      key: `${index}-${tenant.name ?? ''}`,
      name: tenant.name ?? 'Tenant',
      unit: tenant.unit,
      phones: tenant.phones.map((phone) => ({ display: phone, dial: dialable(phone) })),
    })),
    accessNotes: read.accessNotes,
    notes: read.notes,
    completionSteps: read.completionInstructions,
    inspectionNotNeeded: read.occupiedInspectionNotNeeded,
    raw: read.raw,
  };
}

/** "20x25x4 × 2 · media · upstairs hallway" */
export function filterLine(filter: VisitDetailsFilter): string {
  const size = filter.quantity > 1 ? `${filter.size} × ${filter.quantity}` : filter.size;
  return [size, filter.media ? 'media' : null, filter.location].filter(Boolean).join(' · ');
}

/** What a `tel:` or `sms:` link needs: digits, and a leading + when there is one. */
export function dialable(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}
