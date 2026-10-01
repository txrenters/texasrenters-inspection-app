/**
 * A property as Propertyware describes it, beyond its address and units.
 *
 * The office keeps most of what it needs to know about a home in Propertyware:
 * the building record itself (year built, rent, pets, the management contract)
 * and some sixty custom fields filled in by hand -- occupancy status, the make
 * ready, the utility providers, the HVAC filters, the last filter delivery and
 * inspections, the lockbox and gate codes. The console showed none of it
 * (the office, 2026-10-01: "what we are missing is all the details of the
 * property like what we have from PropertyWare").
 *
 * The sync keeps a snapshot of it on the building (`details`), refreshed
 * whenever Propertyware reports the building changed and every night.
 */

/** One custom field as Propertyware holds it: the office's own label, the value as typed. */
export interface PropertyCustomField {
  name: string;
  value: string;
}

export interface PropertyManagerOnFile {
  name: string;
  email: string | null;
  role: string | null;
}

export interface PropertyDetailsSnapshot {
  building: {
    yearBuilt: number | null;
    floors: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    neighborhood: string | null;
    county: string | null;
    parcelNumber: string | null;
    amenities: string[];
  };
  leasing: {
    /** "Occupied" or "Vacant", as Propertyware sets it. */
    status: string | null;
    ready: boolean | null;
    rentable: boolean | null;
    availableDate: string | null;
    targetRent: number | null;
    targetDeposit: number | null;
    petsAllowed: boolean | null;
    smokingAllowed: boolean | null;
    publishedForRent: boolean | null;
    postingTitle: string | null;
    description: string | null;
    comments: string | null;
  };
  management: {
    contractStart: string | null;
    contractEnd: string | null;
    maintenanceLimit: number | null;
    /** What the limit is per: "Per Request", "Per Month". */
    maintenanceLimitPeriod: string | null;
    maintenanceNotice: string | null;
    managers: PropertyManagerOnFile[];
  };
  /** When, and by whom, Propertyware last changed the building. */
  updated: { at: string | null; by: string | null };
  /**
   * Every custom field with a value, as typed -- placeholders included. What
   * reads as empty is decided when it is shown (`isPlaceholderValue`), so a
   * change to that rule needs no sync to take effect.
   */
  customFields: PropertyCustomField[];
}

/** Owners and their phones, from the office's property-owner report. */
export interface PropertyOwnerDetails {
  owners: string | null;
  portfolioName: string | null;
  mobilePhones: string | null;
  homePhones: string | null;
  managementAgreementSignedOn: string | null;
}

/**
 * What the property page shows to anyone who may read properties.
 *
 * The access codes and the owners' phone numbers are left out: they are what
 * opens a tenant's home and reaches its owner, so they are sent only on their
 * own request, to people who manage properties (`PropertyPrivateDetails`).
 */
export interface PropertyDetailsView extends Omit<PropertyDetailsSnapshot, 'customFields'> {
  customFields: PropertyCustomField[];
  /** How many access fields hold something, so the page can say there is something to show. */
  accessFieldsOnFile: number;
}

export interface PropertyOwnerView {
  owners: string | null;
  portfolioName: string | null;
  managementAgreementSignedOn: string | null;
  /** Whether a phone number is on file, without it. */
  phonesOnFile: boolean;
}

/** The access codes and owner phones, for someone who manages properties. */
export interface PropertyPrivateDetails {
  access: { name: string; label: string; value: string }[];
  ownerPhones: { mobile: string | null; home: string | null } | null;
}

/**
 * Custom fields that open a home or let somebody in: shown only on request,
 * to people who manage properties, and never cached or logged.
 *
 * Matched by the office's labels, and by a pattern too, so a field renamed
 * in Propertyware ("Lockbox code #") is still treated as one.
 */
export const ACCESS_FIELD_NAMES = [
  'Lockbox Code',
  'Gated Community? Gate Code?',
  'Alarm System Code',
  'Garage Remotes_Garage Code',
  'Mailbox Keys',
  'Key Information - anything we need to know',
] as const;

const ACCESS_FIELD_PATTERN = /lock\s*box|alarm|gate\s*code|garage.*(code|remote)|mailbox\s*key|key\s*info/i;

export function isAccessField(name: string): boolean {
  const key = name.trim().toLowerCase();
  return ACCESS_FIELD_NAMES.some((field) => field.toLowerCase() === key) || ACCESS_FIELD_PATTERN.test(name);
}

/**
 * A value the office leaves in a field it has not filled: the dropdown's
 * "Not Completed", "UPDATE", "N/A", a lone dot. Shown as empty.
 *
 * "None" and "No" are kept: "Last occupied inspection: None" and "Fireplace:
 * No" are answers, not blanks.
 */
const PLACEHOLDER = /^(?:not\s+completed|update|n\s*\/?\s*a|not\s+provided|not\s+applicable|tbd|unknown|select|\.+|-+|\?+)$/i;

export function isPlaceholderValue(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  return !text || PLACEHOLDER.test(text);
}

/** How a custom field is labelled on the page; the office's own label when it reads well. */
const FIELD_LABELS: Record<string, string> = {
  'Gated Community? Gate Code?': 'Gate code',
  'Garage Remotes_Garage Code': 'Garage remotes / code',
  'Key Information - anything we need to know': 'Key information',
  'Owner Pet Prefences': 'Owner pet preferences',
  'Bills paid for Homeowner - ie HOA': 'Bills paid for the owner',
  'HOA - Attach Documents in Notes': 'HOA',
  'Neighborhood Ammenity Access': 'Neighborhood amenity access',
  'Contact Info for Neighborhood Amenities': 'Neighborhood amenity contact',
  'Last Property Code Work Completed_Inspected': 'Last code work completed / inspected',
  'Inspection Checked by and date checked': 'Inspection checked by',
  'HVAC Filter Location Information': 'HVAC filter location',
  'Date 1st Mgmt Agreement Signed': 'First management agreement signed',
  'Date PM Agreement Updated': 'Management agreement updated',
  'Utilities Handled by HOA': 'Utilities handled by HOA',
  'TBP Start Date': 'Benefit package start date',
};

export function customFieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

/**
 * The custom fields grouped as the office works them, the ones that change
 * most first. A field in none of these still shows, under "Other", so a field
 * the office adds in Propertyware is never silently dropped.
 */
export const PROPERTY_DETAIL_SECTIONS: readonly { title: string; fields: readonly string[] }[] = [
  {
    title: 'Status & make ready',
    fields: [
      'Occupancy Status',
      'Make Ready Notes',
      'Make Ready Repairs',
      'Painting Required',
      'Paint Color',
      'Carpet Care',
      'Carpet Cleaning',
      'Final Clean',
      'Cleaning Service',
      'Debris Removal',
      'Lawn Care During Marketing',
      'Property Re-Key',
      'Code Work',
      'Last Property Code Work Completed_Inspected',
      'Last Winterization',
      'Service Provided',
    ],
  },
  {
    title: 'Benefit package & HVAC',
    fields: [
      'Zone',
      'Management Plan',
      'HVAC Plan',
      'TBP Start Date',
      'Last Filter Delivery',
      'Last HVAC Inspection',
      'Last Occupied Inspection',
      'Inspection Checked by and date checked',
      'HVAC Filter Location Information',
      'HVAC Filter Size 1',
      'HVAC Filter Size 2',
      'HVAC Filter Size 3',
      'HVAC Filter Size 4',
    ],
  },
  {
    title: 'Utilities & services',
    fields: [
      'Utilities',
      'Water Provider',
      'Gas Provider',
      'Trash Provider',
      'Utilities Handled by HOA',
      'Bills paid for Homeowner - ie HOA',
      'HOA - Attach Documents in Notes',
      'Home Warranty',
      'Pool Service',
      'Yard Care During Lease',
      'Yard Features',
      'Included Appliances',
      'Fireplace',
      'Neighborhood Ammenity Access',
      'Contact Info for Neighborhood Amenities',
    ],
  },
  {
    title: 'Where things are',
    fields: ['Breaker Box Location', 'Water Shut Off Valve Location', 'Gas Shut Off Valve Location'],
  },
  {
    title: 'Pets & owner',
    fields: [
      'Pet Restrictions',
      'Owner Pet Prefences',
      'Owner Preferred Communication',
      'Date 1st Mgmt Agreement Signed',
      'Date PM Agreement Updated',
      'Leasing Charge Plan',
      'Legal Description',
    ],
  },
];

export interface PropertyDetailRow {
  name: string;
  label: string;
  /** Null when Propertyware holds nothing, or only a placeholder. */
  value: string | null;
}

/**
 * The custom fields in their sections, in order, each with a value or null.
 *
 * Every field the section names is listed, filled or not, so the office sees
 * at a glance what nobody has entered yet. Access fields never appear here;
 * they have their own card. Anything else Propertyware holds lands in "Other".
 */
export function propertyDetailSections(
  fields: readonly PropertyCustomField[],
): { title: string; rows: PropertyDetailRow[] }[] {
  const byName = new Map(fields.map((field) => [field.name.trim().toLowerCase(), field] as const));
  const placed = new Set<string>();
  const row = (name: string): PropertyDetailRow => {
    const key = name.trim().toLowerCase();
    placed.add(key);
    const value = byName.get(key)?.value ?? null;
    return { name, label: customFieldLabel(name), value: isPlaceholderValue(value) ? null : value!.trim() };
  };
  const sections = PROPERTY_DETAIL_SECTIONS.map((section) => ({
    title: section.title,
    rows: section.fields.filter((name) => !isAccessField(name)).map(row),
  }));
  const other = fields
    .filter((field) => !placed.has(field.name.trim().toLowerCase()) && !isAccessField(field.name))
    .map((field) => row(field.name));
  return other.length ? [...sections, { title: 'Other', rows: other }] : sections;
}
