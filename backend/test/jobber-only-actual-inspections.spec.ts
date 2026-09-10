import {
  NOT_AN_INSPECTION_REASON,
  namesAnInspection,
  titleNamesAnInspection,
} from '../src/integrations/jobber/jobber.visit-type';

/**
 * Which Jobber visits are inspections at all.
 *
 * Every title below is real, taken from the live calendar on 2026-09-10. The
 * maintenance work orders were doing two different kinds of damage: the ten
 * HVAC ones resolved to an inspection type and were imported, putting repair
 * jobs in front of technicians under the word "inspection"; the other eighteen
 * matched nothing and were *refused*, which is worse than being dropped —
 * a refusal is work waiting for a person, so the console showed a queue of
 * eighteen jobs nobody was ever going to import.
 */

/** Repair work orders that resolved to HVAC and were imported as inspections. */
const HVAC_WORK_ORDERS = [
  '1730 Macclesby Ln - 1730 Macclesby Lane - Zone 4 - HVAC  - #44027',
  '21538 Duke Alexander Dr - Zone 4 - HVAC - 21538 Duke Alexander Dr - 43953',
  '4734 Spellman Rd - 4734 Spellman Rd. - Zone 3 - HVAC  - #43919',
];

/** Maintenance that matched no type and sat refused in the console. */
const MAINTENANCE_WORK_ORDERS = [
  '11911 24th St - Zone 4 - Cleaning',
  '12618 Alta Vis - Zone 1 - Make copies of keys',
  '12714 Plummersville St - 12714 Plummersville - Zone 2 - Water leak - #44084',
  '1502B Creekside Ln - 1502B Creekside Ln - Zone 5- Toilet not Working - WO#44098',
  '3025 Waxwing Drive - 3025 Waxwing Drive - Zone 2 - Smoke Alarm - #44087',
  '18618 Seaton Dr - 18618 Seaton dr - Zone 2- Drywall Repair - #43678',
  '7811 Blackbird Lane - 7811 Blackbird Lane - Zone 4 - Turnover - #43000',
];

/** Real inspections. The last three carry a work order number as well. */
const REAL_INSPECTIONS = [
  '319 Fantasy Ln - Zone 1 - Move In Inspection - 40780',
  '7575 Katy Fwy Apt 27 - Occupied Inspection',
  '21227 Teal Lovegrass Ln Cypress (Harris County) TX 77433 - Code Work + Move in Inspection -  Work Order #42914',
  '3903 Dodington Ash Drive Fulshear - Zone 2 - Code Work, Move-in Inspection & Pick up Signs #42014',
  '2323 Pine Cone Dr - Zone 1 - Professional Home Cleaning & Move in Inspection - #42035',
];

describe('a visit is only an inspection when it says so', () => {
  it.each(HVAC_WORK_ORDERS)('does not import the HVAC repair %s', (title) => {
    expect(titleNamesAnInspection(title)).toBe(false);
  });

  it.each(MAINTENANCE_WORK_ORDERS)('does not import the work order %s', (title) => {
    expect(titleNamesAnInspection(title)).toBe(false);
  });

  it.each(REAL_INSPECTIONS)('imports %s', (title) => {
    expect(titleNamesAnInspection(title)).toBe(true);
  });

  /**
   * The rule that looks obvious and is wrong.
   *
   * Keying on the work order number would drop eleven genuine move-in
   * inspections, because the office bundles the inspection with the code work
   * it is booked alongside. The number correlates with work orders; the missing
   * word is what actually separates them.
   */
  it('keeps an inspection that carries a work order number', () => {
    const bundled =
      '21227 Teal Lovegrass Ln Cypress (Harris County) TX 77433 - Code Work + Move in Inspection -  Work Order #42914';
    expect(bundled).toMatch(/#\d{4,}/);
    expect(titleNamesAnInspection(bundled)).toBe(true);
  });

  /** Both misspellings are from live titles of real move-in inspections. */
  it.each(['1701 Cindy Lane - Zone 1 - Move in inspeciton', '2762 Foliage Green Dr - Zone 4 - Move in Inscpection'])(
    'survives the office typing it as %s',
    (title) => {
      expect(titleNamesAnInspection(title)).toBe(true);
    },
  );

  /** A cleaning booked before a move-in is not the inspection. */
  it.each([
    '1614 Talbrook Dr - Zone 1 - Pre-Move in Cleaning',
    '605 Sorrento Dr - Zone 4 - Pre Move-in Cleaning - 41044',
  ])('does not import %s', (title) => {
    expect(titleNamesAnInspection(title)).toBe(false);
  });
});

describe('the occupied walkthrough hidden in a filter delivery', () => {
  const TBP = '19803 Bolton Bridge Ln - Zone 1 - Q3 2026 Tenant Benefit Package';

  /**
   * Sixty-seven live occupied inspections have a title that never says the
   * word. Gating on the title alone would have dropped every one of them.
   */
  it('is still an inspection, on the strength of its details', () => {
    expect(titleNamesAnInspection(TBP)).toBe(false);
    expect(
      namesAnInspection(TBP, 'Filter Change: 18x36x1 + Pest Control + Occupied Inspection'),
    ).toBe(true);
  });

  it('is not an inspection when the details do not say so', () => {
    expect(namesAnInspection(TBP, 'Filter Change: 18x36x1 + Pest Control')).toBe(false);
  });

  /**
   * Details rescue the occupied case and nothing wider. A work order whose
   * notes happen to mention other work must not become an inspection.
   */
  it('does not let unrelated details rescue a work order', () => {
    expect(
      namesAnInspection('18618 Seaton Dr - Zone 2 - Drywall Repair - #43678', 'Patch and repaint'),
    ).toBe(false);
  });
});

describe('what the console is told', () => {
  it('says why, and how to change it', () => {
    expect(NOT_AN_INSPECTION_REASON).toMatch(/not named as an inspection/i);
    expect(NOT_AN_INSPECTION_REASON).toMatch(/rename/i);
  });
});
