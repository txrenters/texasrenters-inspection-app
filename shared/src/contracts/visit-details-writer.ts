/**
 * The title and Details this system writes on a Jobber visit it books.
 *
 * The office's own format, reproduced rather than improved: coordinators and
 * technicians have read "Filter Change: ... + Pest Control + Occupied
 * Inspection (Basic Plan - Opted Out HVAC Plan)" on every benefit-package visit,
 * and a tidier layout would be a change nobody asked for on the one text
 * everybody in the workflow reads. What changes is what the office asked to
 * change: the completion steps point at the app, which now reports the services
 * itself, and a link leads back to the inspection.
 *
 * Whatever is written here has to read back the same through
 * `parseVisitDetails`, and has to keep "Occupied Inspection" on the services
 * line -- that phrase is what makes the sync import the visit as an occupied
 * inspection at all. Both are pinned by tests.
 */

import { quarterLabel, quarterOf } from './quarter-plan.js';
import { FILTER_SIZE_PATTERN, normalizeFilterSize } from './visit-services.js';

export interface OccupiedVisitFilter {
  size: string;
  quantity?: number;
  location?: string | null;
  media?: boolean;
}

export interface OccupiedVisitTenant {
  name: string;
  phones: string[];
  /** For a visit covering several units: "101 1/2 N Main St". */
  unit?: string | null;
}

export interface OccupiedVisitBooking {
  services: { filterChange: boolean; pestControl: boolean; fleaTreatment: boolean };
  filters: OccupiedVisitFilter[];
  /** "Basic", "Standard", "Premium", "BX", "MX". */
  planTier: string | null;
  hvacOptedOut: boolean;
  contactTenantsBeforeArrival: boolean;
  tenants: OccupiedVisitTenant[];
  /** "Gate Code: 4321", one per line. */
  accessNotes: string[];
  /** Anything else for the technician, one paragraph each. */
  notes: string[];
  /** Where the inspection is in the console. */
  inspectionUrl: string | null;
}

/**
 * The office's completion steps, pointed at the app.
 *
 * The first step used to ask technicians to type the service numbers into
 * Jobber's notes; the app now asks before submission and posts them itself.
 * The rest are the office's own, word for word.
 */
export const OCCUPIED_COMPLETION_STEPS = [
  '• Mark each service done or not done in the Texas Renters inspection app before submitting. The app adds the numbers to this job’s notes: 1.Filter Change 2.Pest Control 3.HVAC / Occupied Inspection',
  '• Note the size of any filters that were not replaced and/or filters that are not listed.',
  '• Check for any potential repairs and create a work order if needed.',
  '• Make sure all lights or appliances are off after the job is completed if tenants are not at home.',
  'Note: If the property is inaccessible, please do the outside pest control only do not leave/drop the filters at their doors.',
] as const;

/** "Q4 2026", the quarter a visit day ("2026-10-06") falls in. */
function visitQuarter(day: string): string {
  return quarterLabel(quarterOf(new Date(`${day}T00:00:00Z`)));
}

/** The kinds of inspection the console can book a Jobber visit for. */
export const BOOKABLE_INSPECTION_TYPES = ['OCCUPIED', 'MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET', 'HVAC'] as const;
export type BookableInspectionType = (typeof BOOKABLE_INSPECTION_TYPES)[number];

export function isBookableInspectionType(type: string | null | undefined): type is BookableInspectionType {
  return (BOOKABLE_INSPECTION_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * What each kind of visit is called at the end of its title, as the office writes it.
 *
 * The most common spelling of each, read from the office's own visits on
 * 2026-09-15 -- "Move in Inspection" 46 times, "Move out inspection" 32 -- and
 * each still types as its inspection from the title alone.
 */
const VISIT_KIND: Record<Exclude<BookableInspectionType, 'OCCUPIED'>, string> = {
  MOVE_IN: 'Move in Inspection',
  MOVE_OUT: 'Move out inspection',
  BACK_TO_MARKET: 'BTM Inspection',
  HVAC: 'HVAC Inspection',
};

/** Where the office's steps said to upload to Inspect Cloud, which the app replaces. */
const SUBMIT_IN_APP = 'Submit it in the Texas Renters inspection app';

/**
 * The completion block the office writes on each kind of visit, heading first.
 *
 * Word for word from their visits (the lines shared by every one of them),
 * with one change: "Upload to Inspect Cloud" becomes submitting in the app,
 * which is where these inspections are done now. The numbering is kept, because
 * the office reads "1, 3" in a job's notes against it. A move-in's "call Frank
 * about the sign" lines are left out: they are on a third of the visits, and
 * carry a phone number.
 *
 * HVAC has no office template to copy -- one visit, no steps -- so it asks
 * only for the one thing that is certain.
 */
export const COMPLETION_BLOCKS: Record<Exclude<BookableInspectionType, 'OCCUPIED'>, readonly string[]> = {
  MOVE_IN: [
    'Completion Instruction',
    '• Indicate in the notes which services were completed by using the corresponding numbers:',
    '1. Conduct Move in inspection.',
    `2. ${SUBMIT_IN_APP}.`,
    '3. Add cockroach baits on kitchen cabinets',
    '4. Assess if it needs professional cleaning.',
    '5. Check if it needs installation for float switch or if its already installed.',
    '• Note if it needs installation for float switch or if its already installed',
    '• If needed refresh cleaning or professional cleaning, inform us while you are at the location so we can schedule it in Jobber',
    '• Put additional notes if needed',
    '•Document and let Franc know if and how many locks are on kwik set locks/the easy rekey tool system',
  ],
  MOVE_OUT: [
    'Completion Instruction',
    '• Conduct Move out inspection',
    '- Thoroughly check for any damages and Make work order',
    `• ${SUBMIT_IN_APP}`,
    '• Put additional notes if needed',
    '• Document and let Franc know if and how many locks are on kwik set locks/the easy rekey tool system',
    "• Asses the doors and take picture if it's on kwik set system.",
  ],
  BACK_TO_MARKET: [
    'Instruction Completion',
    'Note: Pick up sign/supra/lockbox at the office',
    '1. Conduct BTM Inspection',
    `2. ${SUBMIT_IN_APP}`,
    '3. Place Sign, Supra, and Lockbox',
  ],
  HVAC: ['Instruction for completion', `• Complete the HVAC inspection in the Texas Renters inspection app.`],
};

/**
 * The visit title, in the shape the office already reads.
 *
 * A benefit-package visit is "<address> - Zone 4 - Q4 2026 Tenant Benefit
 * Package", exactly as the quarterly planner and the coordinators write it. A
 * one-off occupied inspection outside the programme says so instead, and still
 * types as an occupied inspection from its title alone.
 */
export function occupiedVisitTitle(input: {
  address: string;
  zone: string | null;
  scheduledOn: string;
  benefitPackage: boolean;
}): string {
  const kind = input.benefitPackage
    ? `${visitQuarter(input.scheduledOn)} Tenant Benefit Package`
    : 'Occupied Inspection';
  return [input.address.trim() || 'Unknown address', input.zone?.trim(), kind].filter(Boolean).join(' - ');
}

/**
 * The job's title: the visit title without the address.
 *
 * "Zone 1 - Q3 2026 Tenant Benefit Package" is how the office titles the job a
 * benefit-package visit hangs on, and the address lives on the visit alone.
 */
export function occupiedJobTitle(input: { zone: string | null; scheduledOn: string; benefitPackage: boolean }): string {
  const kind = input.benefitPackage
    ? `${visitQuarter(input.scheduledOn)} Tenant Benefit Package`
    : 'Occupied Inspection';
  return [input.zone?.trim(), kind].filter(Boolean).join(' - ');
}

/**
 * The Details for a kind of visit other than occupied.
 *
 * Who to call, how to get in and anything else the coordinator wrote, then a
 * link back to the inspection, then the office's completion block for that
 * kind. There is no services line: filters, pest control and the plan are the
 * benefit-package visit's business. And nothing here may say "occupied
 * inspection" -- the sync would read the visit as one.
 */
export function formatVisitDetails(
  inspectionType: Exclude<BookableInspectionType, 'OCCUPIED'>,
  booking: Pick<OccupiedVisitBooking, 'contactTenantsBeforeArrival' | 'tenants' | 'accessNotes' | 'notes' | 'inspectionUrl'>,
): string {
  const paragraphs = [
    [
      booking.contactTenantsBeforeArrival ? 'Make sure to contact tenants that you are on your way.' : null,
      ...tenantLines(booking.tenants),
    ]
      .filter(Boolean)
      .join('\n'),
    booking.accessNotes.map((note) => note.trim()).filter(Boolean).join('\n'),
    ...booking.notes.map((note) => note.trim()).filter(Boolean),
    booking.inspectionUrl ? `Texas Renters inspection: ${booking.inspectionUrl}` : null,
    COMPLETION_BLOCKS[inspectionType].join('\n'),
  ];
  return paragraphs.filter((paragraph) => paragraph && paragraph.trim()).join('\n\n');
}

function tenantLines(tenants: OccupiedVisitTenant[]): string[] {
  return tenants
    .filter((tenant) => tenant.name.trim() || tenant.phones.length)
    .map((tenant) =>
      [tenant.unit?.trim() ? `${tenant.unit.trim()} - Tenant:` : 'Tenant:', tenant.name.trim(), ...tenant.phones]
        .filter(Boolean)
        .join(' '),
    );
}

export function formatOccupiedVisitDetails(booking: OccupiedVisitBooking): string {
  const tier = booking.planTier?.trim() ?? '';
  const plan = [
    // "Premium (w/o HVAC)" is already a plan's whole name; "Basic" gets "Plan".
    tier ? (/plan|\)$/i.test(tier) ? tier : `${tier} Plan`) : null,
    booking.hvacOptedOut ? 'Opted Out HVAC Plan' : null,
  ].filter(Boolean);
  const filters = booking.filters
    .filter((filter) => filter.size.trim())
    .map((filter) =>
      [
        filter.quantity && filter.quantity > 1 ? `(${filter.quantity} pcs) ` : '',
        filter.size.trim(),
        filter.media ? ' MEDIA' : '',
        filter.location?.trim() ? ` (${filter.location.trim()})` : '',
      ].join(''),
    );
  const services = [
    booking.services.filterChange
      ? `Filter Change: ${filters.length ? filters.join('; ') : 'Update filter sizes'}`
      : null,
    booking.services.pestControl ? 'Pest Control' : null,
    booking.services.fleaTreatment ? 'Flea Treatment' : null,
    // Always, and always on this line: it is what the sync reads.
    `Occupied Inspection${plan.length ? ` (${plan.join(' - ')})` : ''}`,
  ]
    .filter(Boolean)
    .join(' + ');

  const tenants = tenantLines(booking.tenants);

  const paragraphs = [
    services,
    [
      booking.contactTenantsBeforeArrival ? 'Make sure to contact tenants that you are on your way.' : null,
      ...tenants,
    ]
      .filter(Boolean)
      .join('\n'),
    booking.accessNotes.map((note) => note.trim()).filter(Boolean).join('\n'),
    ...booking.notes.map((note) => note.trim()).filter(Boolean),
    // Before the completion steps: everything after their heading is read as
    // one of them.
    booking.inspectionUrl ? `Texas Renters inspection: ${booking.inspectionUrl}` : null,
    ['Instruction for completion', ...OCCUPIED_COMPLETION_STEPS].join('\n'),
  ];
  return paragraphs.filter((paragraph) => paragraph && paragraph.trim()).join('\n\n');
}

/** A tenancy as the Propertyware tenant report carries it, for booking its visit. */
export interface TenancyForBooking {
  zone: string | null;
  managementPlan: string | null;
  hvacPlan: string | null;
  hvacFilterLocation: string | null;
  hvacFilterSizes: string[];
  tbpEnrollment: string | null;
  /** From the tenancy's lease, when there is one. The report carries no phones. */
  tenantNames: string[];
}

export interface BookingPrefill {
  zone: string | null;
  benefitPackage: boolean;
  planTier: string | null;
  hvacOptedOut: boolean;
  filters: OccupiedVisitFilter[];
  tenants: OccupiedVisitTenant[];
}

/** The filter-location values the report holds that are not places: "UPDATE", "n/a", "TBD", ".". */
const NOT_A_LOCATION = /^(?:update|not completed|n\/?a|tbd|none|\.+|-+)$/i;
const SIZE_IN_TEXT = /(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\s*[xX×]\s*(\d+(?:\.\d+)?))?/;

/**
 * A tenancy's zone as the office writes it in a Jobber title: "Zone 4".
 *
 * The tenant report holds zones as bare numbers ("4") and "Not Set" where there
 * is none. Copied as they are, a title reads "- 4 -" or "- Not Set -" in the one
 * segment the office reads as "- Zone 4 -". Anything that is not a numbered
 * zone is null, so a title leaves the segment out. The console's booking, the
 * quarterly planner's visit title and the job a planned visit is booked on all
 * read the zone through this, so the three cannot write it differently.
 */
export function tenancyZoneLabel(zone: string | null | undefined): string | null {
  const zoneNumber = /^(?:zone\s*)?(\d{1,2})$/i.exec(zone?.trim() ?? '')?.[1];
  return zoneNumber ? `Zone ${Number(zoneNumber)}` : null;
}

/**
 * What a booking starts from, read off the tenant report.
 *
 * Only a start: the report is typed by hand and holds "UPDATE" where a filter
 * location should be, zones as bare numbers, and no phone numbers at all. Every
 * value here is shown to the office to correct before anything is booked.
 */
export function bookingFromTenancy(tenancy: TenancyForBooking): BookingPrefill {
  const location = tenancy.hvacFilterLocation?.trim() ?? '';
  const usableLocation = location && !NOT_A_LOCATION.test(location) && !SIZE_IN_TEXT.test(location) ? location : null;
  const filters = tenancy.hvacFilterSizes
    .map((entry) => {
      const size = SIZE_IN_TEXT.exec(entry);
      if (!size) return null;
      return {
        size: [size[1], size[2], size[3]].filter(Boolean).join('x'),
        media: /\bmedia\b/i.test(entry),
      } as OccupiedVisitFilter;
    })
    .filter((filter): filter is OccupiedVisitFilter => filter !== null);
  // A location names where a filter is; with several sizes it cannot say which.
  if (filters.length === 1 && usableLocation) filters[0] = { ...filters[0]!, location: usableLocation };
  return {
    zone: tenancyZoneLabel(tenancy.zone),
    benefitPackage: tenancy.tbpEnrollment?.trim().toLowerCase() === 'yes',
    planTier: tenancy.managementPlan?.trim() || null,
    hvacOptedOut: /opted\s*out/i.test(tenancy.hvacPlan ?? ''),
    filters,
    tenants: tenancy.tenantNames.map((name) => name.trim()).filter(Boolean).map((name) => ({ name, phones: [] })),
  };
}

/** What the console sends to book an occupied inspection's visit in Jobber. */
export interface JobberBookingInput extends Omit<OccupiedVisitBooking, 'inspectionUrl'> {
  /** "Zone 4", or null when the tenancy has none. */
  zone: string | null;
  /** Titles the visit as the quarter's Tenant Benefit Package rather than a one-off. */
  benefitPackage: boolean;
}

export const MAX_BOOKING_FILTER_QUANTITY = 20;

/**
 * What stops a booking from being sent, in words for the coordinator.
 *
 * Empty when it can go. The console disables its button on this and the API
 * refuses on it, so the two cannot disagree about what is bookable.
 */
export function jobberBookingProblems(
  input: JobberBookingInput,
  inspectionType: BookableInspectionType = 'OCCUPIED',
): string[] {
  const problems: string[] = [];
  // Sizes only matter on a benefit-package visit that books the filter change;
  // anywhere else, none are written.
  if (inspectionType !== 'OCCUPIED' || !input.services.filterChange) return problems;
  for (const filter of input.filters) {
    if (!FILTER_SIZE_PATTERN.test(filter.size))
      problems.push(`"${filter.size.trim() || 'blank'}" is not a filter size like 20x25x1.`);
    if (
      filter.quantity !== undefined &&
      (!Number.isInteger(filter.quantity) || filter.quantity < 1 || filter.quantity > MAX_BOOKING_FILTER_QUANTITY)
    )
      problems.push(`Filter ${filter.size.trim()} needs a quantity from 1 to ${MAX_BOOKING_FILTER_QUANTITY}.`);
  }
  return problems;
}

/** Everything a booking writes in Jobber. */
export interface JobberBookingText {
  jobTitle: string;
  visitTitle: string;
  visitDetails: string;
}

/**
 * The job title, visit title and Details for a booking, from one place.
 *
 * The console previews exactly this and the API sends exactly this, so what a
 * coordinator reads before booking is what lands in Jobber.
 */
export function jobberBookingText(
  input: JobberBookingInput,
  visit: {
    /** Occupied when omitted: the kind the console first booked. */
    inspectionType?: BookableInspectionType;
    address: string;
    scheduledOn: string;
    inspectionUrl: string | null;
  },
): JobberBookingText {
  const zone = input.zone?.trim() || null;
  const type = visit.inspectionType ?? 'OCCUPIED';
  if (type !== 'OCCUPIED') {
    const kind = VISIT_KIND[type];
    return {
      jobTitle: [zone, kind].filter(Boolean).join(' - '),
      visitTitle: [visit.address.trim() || 'Unknown address', zone, kind].filter(Boolean).join(' - '),
      visitDetails: formatVisitDetails(type, { ...input, inspectionUrl: visit.inspectionUrl }),
    };
  }
  return {
    jobTitle: occupiedJobTitle({ zone, scheduledOn: visit.scheduledOn, benefitPackage: input.benefitPackage }),
    visitTitle: occupiedVisitTitle({
      address: visit.address,
      zone,
      scheduledOn: visit.scheduledOn,
      benefitPackage: input.benefitPackage,
    }),
    visitDetails: formatOccupiedVisitDetails({
      ...input,
      filters: input.filters.map((filter) => ({ ...filter, size: normalizeFilterSize(filter.size) })),
      inspectionUrl: visit.inspectionUrl,
    }),
  };
}

/** Whether a property can be booked against, and which Jobber property that is. */
export type JobberPropertyLinkState = 'LINKED' | 'NOT_LINKED' | 'AMBIGUOUS';

/** What the console needs to offer a booking before the inspection exists. */
export interface JobberBookingContext {
  /** Whether this server books visits in Jobber at all (JOBBER_BOOKING_ENABLED). */
  enabled: boolean;
  /** Whether a Jobber account is connected and authorized. */
  connected: boolean;
  jobberProperty: { status: JobberPropertyLinkState; address: string | null };
  /** The street address the visit title starts with. */
  address: string;
  /** A start read off the tenant report and the lease, or null when neither says anything. */
  prefill: BookingPrefill | null;
  /** Whether the chosen technician can be put on the Jobber visit; null with no technician. */
  technicianInJobber: boolean | null;
}

/** How far a booking has got, as the console shows it on the inspection. */
export interface JobberBookingStatus {
  status: 'PENDING' | 'SENT' | 'FAILED' | 'ABANDONED';
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
}
