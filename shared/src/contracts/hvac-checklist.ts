/**
 * The office's HVAC inspection checklist, transcribed from the printed form.
 *
 * Source: "THMP HVAC Inspection Checklist" (PDF, signed off 2026-09-02). This
 * replaced a nine-item placeholder that was explicitly labelled a draft
 * "awaiting the office's sign-off … to be replaced wholesale the moment
 * somebody produces the real standard".
 *
 * Ordered as the form is, which is the order a technician walks it: thermostat
 * first because it is inside the door, then the filter, indoor unit, ducts, and
 * outside last. Section names match the printed headings so a technician
 * holding the paper and a technician holding the phone are on the same line.
 *
 * Two sections of the form are deliberately absent:
 *
 * - **Equipment header** (system type, age, brand/model) describes the plant,
 *   not the inspection. It belongs on the property, not on one visit's
 *   checklist, and putting it here would re-ask it twice a year for ever.
 * - **Issues found** is five blank lines on paper. This app already has
 *   findings, which are reviewable, photographable and chargeable; a parallel
 *   list of free text would be a worse copy of them.
 */

/** How one item is answered. */
export type HvacResponseType =
  /** The three condition flags plus a comment — the existing behaviour. */
  | 'STATUS'
  /** A number with a unit. Temperature split is diagnosis, not decoration. */
  | 'READING'
  /** Free text where the form prints a blank line rather than a measurement. */
  | 'TEXT'
  /** Exactly one of `choices`. */
  | 'CHOICE';

export interface HvacChecklistItem {
  /** The printed section heading, used to group the list on screen. */
  section: string;
  label: string;
  responseType: HvacResponseType;
  /** READING only. Shown beside the field so nobody guesses Celsius. */
  unit?: string;
  /** CHOICE only. */
  choices?: string[];
}

/**
 * What the form offers for both "overall condition" and "recommended action".
 *
 * The printed section 11 has a heading and no visible options; the office
 * confirmed it reuses section 9's five. Kept as one constant so the two can
 * never drift apart.
 */
export const HVAC_CONDITION_CHOICES = [
  'Good — no action required',
  'Maintenance recommended',
  'Repair recommended',
  'Immediate repair required',
  'Replacement recommended',
] as const;

const STATUS = (section: string, label: string): HvacChecklistItem => ({
  section,
  label,
  responseType: 'STATUS',
});

const READING = (section: string, label: string, unit: string): HvacChecklistItem => ({
  section,
  label,
  responseType: 'READING',
  unit,
});

export const HVAC_CHECKLIST: readonly HvacChecklistItem[] = [
  // The form opens with this, before any section number. Photographs already
  // attach to a checklist item, so it is an item rather than a special case.
  {
    section: 'Data plate',
    label: 'Data plate photographed (manufacturer, model, serial, refrigerant)',
    responseType: 'STATUS',
  },

  STATUS('Thermostat', 'Powers on'),
  STATUS('Thermostat', 'Cooling tested'),
  STATUS('Thermostat', 'Heating tested, if applicable'),
  STATUS('Thermostat', 'Fan tested'),
  READING('Thermostat', 'Indoor temperature', '°F'),
  READING('Thermostat', 'Thermostat setting', '°F'),

  STATUS('Air filter', 'Filter present'),
  STATUS('Air filter', 'Correct size'),
  { section: 'Air filter', label: 'Filter size', responseType: 'TEXT' },
  {
    section: 'Air filter',
    label: 'Filter condition',
    responseType: 'CHOICE',
    // One choice rather than two booleans: the form prints "clean" and "dirty —
    // replacement recommended" as separate ticks, and a filter cannot be both.
    choices: ['Clean', 'Dirty — replacement recommended'],
  },
  STATUS('Air filter', 'Filter replaced during visit'),
  STATUS('Air filter', 'Tested'),

  STATUS('Indoor unit / air handler', 'Blower operating properly'),
  STATUS('Indoor unit / air handler', 'Adequate airflow'),
  STATUS('Indoor unit / air handler', 'Evaporator coil inspected'),
  STATUS('Indoor unit / air handler', 'No unusual noise or vibration'),
  STATUS('Indoor unit / air handler', 'No visible water leak'),
  STATUS('Indoor unit / air handler', 'Drain pan inspected'),
  STATUS('Indoor unit / air handler', 'Condensate drain inspected'),
  STATUS('Indoor unit / air handler', 'Float switch tested, if installed'),

  STATUS('Ductwork', 'Supply ducts visually inspected'),
  STATUS('Ductwork', 'Return ducts visually inspected'),
  STATUS('Ductwork', 'Duct connections secure'),
  STATUS('Ductwork', 'No visible gaps or disconnected ducts'),
  STATUS('Ductwork', 'No visible damage to ductwork'),
  STATUS('Ductwork', 'Duct insulation in good condition'),
  STATUS('Ductwork', 'No excessive air leakage observed'),
  STATUS('Ductwork', 'No visible mould or excessive moisture'),
  STATUS('Ductwork', 'Registers / supply vents secure'),
  STATUS('Ductwork', 'Return grille secure and unobstructed'),
  STATUS('Ductwork', 'Overall ductwork condition acceptable'),
  { section: 'Ductwork', label: 'Ductwork issues / recommendations', responseType: 'TEXT' },

  STATUS('Outdoor unit', 'Compressor operating'),
  STATUS('Outdoor unit', 'Condenser fan operating'),
  STATUS('Outdoor unit', 'Condenser coil inspected'),
  STATUS('Outdoor unit', 'Electrical components inspected'),
  STATUS('Outdoor unit', 'Capacitor checked'),
  STATUS('Outdoor unit', 'Refrigerant lines inspected'),
  STATUS('Outdoor unit', 'No visible refrigerant or oil leak'),
  STATUS('Outdoor unit', 'Unit clean and unobstructed'),

  READING('System performance', 'Return air temperature', '°F'),
  READING('System performance', 'Supply air temperature', '°F'),
  READING('System performance', 'Temperature split', '°F'),
  READING('System performance', 'Outdoor temperature', '°F'),
  // The form prints one "___ / ___ PSI" field. Two items rather than a pair
  // type: they are two different readings, and a single string would have to be
  // parsed by anything that ever wanted to compare them.
  READING('System performance', 'Refrigerant pressure — suction', 'PSI'),
  READING('System performance', 'Refrigerant pressure — liquid', 'PSI'),

  STATUS('Heating, if applicable', 'Heating operation tested'),
  STATUS('Heating, if applicable', 'Burner / ignition checked'),
  STATUS('Heating, if applicable', 'Blower operating'),
  STATUS('Heating, if applicable', 'No unusual noise or odour'),
  STATUS('Heating, if applicable', 'Flue / vent visually inspected'),
  STATUS('Heating, if applicable', 'No apparent safety concerns'),

  STATUS('Condensate / drainage', 'Primary condensate drain clear'),
  STATUS('Condensate / drainage', 'Secondary drain inspected'),
  STATUS('Condensate / drainage', 'Condensate pump operating, if installed'),
  STATUS('Condensate / drainage', 'Drain termination properly positioned'),
  STATUS('Condensate / drainage', 'No signs of water damage'),

  {
    section: 'Overall condition',
    label: 'Overall HVAC condition',
    responseType: 'CHOICE',
    choices: [...HVAC_CONDITION_CHOICES],
  },
  {
    section: 'Recommended action',
    label: 'Recommended action',
    responseType: 'CHOICE',
    choices: [...HVAC_CONDITION_CHOICES],
  },
] as const;

/** The section headings in the order the form prints them. */
export function hvacChecklistSections(): string[] {
  return [...new Set(HVAC_CHECKLIST.map((item) => item.section))];
}
