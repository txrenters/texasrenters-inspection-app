import type { BookingPrefill, JobberBookingContext, JobberBookingInput } from '@texasrenters/shared';

/**
 * The Jobber booking form, as typed.
 *
 * Text as the coordinator types it -- a quantity is a string until it is sent,
 * notes are one textarea -- because turning each keystroke into the request
 * shape would swallow the newline somebody is halfway through typing.
 */
export interface BookingFormState {
  zone: string;
  benefitPackage: boolean;
  services: JobberBookingInput['services'];
  filters: { size: string; quantity: string; media: boolean; location: string }[];
  planTier: string;
  hvacOptedOut: boolean;
  contactTenantsBeforeArrival: boolean;
  tenants: { name: string; phones: string; unit: string }[];
  /** One per line: "Gate Code: 4321". */
  accessNotes: string;
  /** Paragraphs, separated by a blank line. */
  notes: string;
}

/**
 * A form started from the tenant report and the lease.
 *
 * Filter change and pest control are ticked because nearly every visit the
 * office books has both; the coordinator unticks what this one does not.
 */
export function bookingForm(prefill: BookingPrefill | null | undefined): BookingFormState {
  return {
    zone: prefill?.zone ?? '',
    benefitPackage: prefill?.benefitPackage ?? false,
    services: { filterChange: true, pestControl: true, fleaTreatment: false },
    filters: (prefill?.filters ?? []).map((filter) => ({
      size: filter.size,
      quantity: filter.quantity ? String(filter.quantity) : '',
      media: Boolean(filter.media),
      location: filter.location ?? '',
    })),
    planTier: prefill?.planTier ?? '',
    hvacOptedOut: prefill?.hvacOptedOut ?? false,
    contactTenantsBeforeArrival: true,
    tenants: (prefill?.tenants ?? []).map((tenant) => ({
      name: tenant.name,
      phones: tenant.phones.join(', '),
      unit: tenant.unit ?? '',
    })),
    accessNotes: '',
    notes: '',
  };
}

/** What is sent: blank rows dropped, text split into the lines and paragraphs it holds. */
export function bookingFromForm(form: BookingFormState): JobberBookingInput {
  return {
    zone: form.zone.trim() || null,
    benefitPackage: form.benefitPackage,
    services: form.services,
    filters: form.filters
      .filter((filter) => filter.size.trim())
      .map((filter) => ({
        size: filter.size.trim(),
        ...(filter.quantity.trim() ? { quantity: Number(filter.quantity) } : {}),
        media: filter.media,
        location: filter.location.trim() || null,
      })),
    planTier: form.planTier.trim() || null,
    hvacOptedOut: form.hvacOptedOut,
    contactTenantsBeforeArrival: form.contactTenantsBeforeArrival,
    tenants: form.tenants
      .map((tenant) => ({
        name: tenant.name.trim(),
        phones: tenant.phones
          .split(/[,;]/)
          .map((phone) => phone.trim())
          .filter(Boolean),
        unit: tenant.unit.trim() || null,
      }))
      .filter((tenant) => tenant.name || tenant.phones.length),
    accessNotes: form.accessNotes
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    notes: form.notes
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean),
  };
}

/** Why this visit cannot be booked from here, or null when it can. */
export function bookingUnavailableReason(context: JobberBookingContext): string | null {
  if (!context.enabled) return 'Booking visits in Jobber is switched off on this server. Book this visit in Jobber.';
  if (!context.connected) return 'Jobber is not connected. Reconnect it on the Jobber page, or book this visit in Jobber.';
  if (context.jobberProperty.status === 'AMBIGUOUS')
    return 'This property is linked to more than one Jobber property, so which one to book is not clear. Fix the link on the Jobber page.';
  if (context.jobberProperty.status === 'NOT_LINKED')
    return 'This property is not linked to a Jobber property yet. Link it on the Jobber page, then come back.';
  return null;
}
