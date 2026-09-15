import {
  HVAC_CHECKLIST,
  HVAC_NOT_PRESENT,
  HVAC_SECTIONS,
  hvacChecklistSections,
  hvacItemAnswered,
  hvacItemsForArea,
  hvacSectionOf,
  hvacUnansweredItems,
  hvacUnansweredMessage,
} from '@texasrenters/shared';

/**
 * The office's own HVAC report (Inspect & Cloud, 10118 Mariposa Green Ct),
 * handed over on 2026-09-16 as the design the console and the handset follow.
 *
 * These assertions are about fidelity to that report. A technician holding the
 * old report and a technician holding the phone have to be on the same row.
 */
describe('the HVAC checklist matches the office’s report', () => {
  it('walks the report’s four sections, in the order it prints them', () => {
    expect(hvacChecklistSections()).toEqual(['Attic', 'Filters', 'A/C unit', 'Thermostat']);
    expect(hvacChecklistSections()).toEqual([...HVAC_SECTIONS]);
  });

  it('asks each section’s rows, in the report’s order', () => {
    const rows = (section: string) =>
      HVAC_CHECKLIST.filter((item) => item.section === section && item.responseType === 'STATUS').map(
        (item) => item.label,
      );

    expect(rows('Attic')).toEqual(['Float switch', 'Drip pan', 'Media filter', 'Furnace condition']);
    // Four rows whatever the property has, as the report prints them.
    expect(rows('Filters')).toEqual(['Filter 1', 'Filter 2', 'Filter 3', 'Filter 4']);
    expect(rows('A/C unit')).toEqual(['Refrigerant type', 'Coil guard', 'Inlet/outlet lines']);
    expect(rows('Thermostat')).toEqual(['Temperature']);
  });

  it('keeps the old form’s readings, each in the section it is taken in, with its unit', () => {
    // The office kept the temperatures and pressures (2026-09-16): typed numbers
    // with a unit, because "18F" in a comment cannot be compared between visits.
    const readings = HVAC_CHECKLIST.filter((item) => item.responseType === 'READING');
    expect(readings.map((item) => `${item.section}: ${item.label} (${item.unit})`)).toEqual([
      'A/C unit: Outdoor temperature (°F)',
      'A/C unit: Refrigerant pressure — suction (PSI)',
      'A/C unit: Refrigerant pressure — liquid (PSI)',
      'Thermostat: Return air temperature (°F)',
      'Thermostat: Supply air temperature (°F)',
      'Thermostat: Temperature split (°F)',
    ]);
  });

  it('gives every item a unique label, because the label is its key', () => {
    // Stored uniquely on (organization, kind, label) for the org-wide rows, so
    // a duplicate would silently collapse two questions into one.
    const labels = HVAC_CHECKLIST.map((item) => item.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives a unit only to readings, and asks no multiple-choice questions', () => {
    for (const item of HVAC_CHECKLIST) {
      if (item.responseType === 'READING') expect(item.unit).toBeTruthy();
      else expect(item.unit).toBeUndefined();
      expect(item.responseType).not.toBe('CHOICE');
    }
  });

  it('is twelve scored rows and six readings', () => {
    expect(HVAC_CHECKLIST.filter((item) => item.responseType === 'STATUS')).toHaveLength(12);
    expect(HVAC_CHECKLIST).toHaveLength(18);
  });
});

describe('an HVAC area asks its own section', () => {
  it('finds the section by the area’s name, whatever its case or spacing', () => {
    expect(hvacSectionOf('Attic')).toBe('Attic');
    expect(hvacSectionOf('  a/c UNIT ')).toBe('A/C unit');
    expect(hvacSectionOf('Kitchen')).toBeNull();
    expect(hvacSectionOf(null)).toBeNull();
  });

  it('asks a section area its section’s items only', () => {
    expect(hvacItemsForArea('Filters').map((item) => item.label)).toEqual(['Filter 1', 'Filter 2', 'Filter 3', 'Filter 4']);
    expect(hvacItemsForArea('Thermostat')).toHaveLength(4);
  });

  /** An inspection created before the sections were areas has one "HVAC System" area, and answers everything there. */
  it('asks the old single area the whole list', () => {
    expect(hvacItemsForArea('HVAC System')).toHaveLength(HVAC_CHECKLIST.length);
  });
});

describe('what finishes an HVAC area', () => {
  const row = { responseType: 'STATUS' };
  const reading = { responseType: 'READING' };

  it('takes a row scored on all three of Clean, Undamaged and Working', () => {
    expect(hvacItemAnswered(row, { isClean: true, isUndamaged: false, isWorking: true })).toBe(true);
    expect(hvacItemAnswered(row, { isClean: true, isUndamaged: true, isWorking: null })).toBe(false);
    expect(hvacItemAnswered(row, null)).toBe(false);
  });

  /** The report's own way of recording a row the property does not have: "Dont have". */
  it('takes a comment saying why a row could not be scored', () => {
    expect(hvacItemAnswered(row, { comment: HVAC_NOT_PRESENT })).toBe(true);
    expect(hvacItemAnswered(row, { comment: '   ' })).toBe(false);
  });

  it('never requires a reading: not every visit carries the gauges', () => {
    expect(hvacItemAnswered(reading, null)).toBe(true);
  });

  it('names what is left, in order, and counts the rest', () => {
    const items = hvacItemsForArea('Attic');
    const left = hvacUnansweredItems(items, (item) =>
      item.label === 'Drip pan' ? { isClean: true, isUndamaged: true, isWorking: true } : null,
    );

    expect(left.map((item) => item.label)).toEqual(['Float switch', 'Media filter', 'Furnace condition']);
    expect(hvacUnansweredMessage(['Filter 1', 'Filter 2', 'Filter 3', 'Filter 4', 'Drip pan'])).toBe(
      'Score Clean, Undamaged and Working, or say why not, for Filter 1, Filter 2, Filter 3 and 2 more.',
    );
  });
});
