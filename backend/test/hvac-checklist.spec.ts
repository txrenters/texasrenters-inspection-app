import { HVAC_CHECKLIST, HVAC_CONDITION_CHOICES, hvacChecklistSections } from '@texasrenters/shared';

/**
 * Transcribed from "THMP HVAC Inspection Checklist" (PDF, 2026-09-02). It
 * replaced a nine-item placeholder whose own comment called it a draft to be
 * "replaced wholesale the moment somebody produces the real standard".
 *
 * These assertions are about fidelity to the printed form. A technician holding
 * the paper and a technician holding the phone have to be on the same line.
 */
describe('the HVAC checklist matches the printed form', () => {
  it('covers every section the form prints, in the order it prints them', () => {
    expect(hvacChecklistSections()).toEqual([
      'Data plate',
      'Thermostat',
      'Air filter',
      'Indoor unit / air handler',
      'Ductwork',
      'Outdoor unit',
      'System performance',
      'Heating, if applicable',
      'Condensate / drainage',
      'Overall condition',
      'Recommended action',
    ]);
  });

  it('asks every measurement the form asks for, with its unit', () => {
    // The diagnostic half of an HVAC inspection. Recorded as free text these
    // are unreadable and uncomparable between visits, which is why the item
    // carries a unit rather than the technician typing "18F" into a comment.
    const readings = HVAC_CHECKLIST.filter((i) => i.responseType === 'READING');
    expect(readings.map((i) => `${i.label} (${i.unit})`)).toEqual([
      'Indoor temperature (°F)',
      'Thermostat setting (°F)',
      'Return air temperature (°F)',
      'Supply air temperature (°F)',
      'Temperature split (°F)',
      'Outdoor temperature (°F)',
      'Refrigerant pressure — suction (PSI)',
      'Refrigerant pressure — liquid (PSI)',
    ]);
  });

  it('splits the one printed pressure field into two readings', () => {
    // The form prints "___ / ___ PSI". Two numbers in one string would have to
    // be parsed by anything that ever wanted to compare them.
    const pressures = HVAC_CHECKLIST.filter((i) => i.unit === 'PSI');
    expect(pressures).toHaveLength(2);
  });

  it('offers the same five options for condition and recommended action', () => {
    // The printed section 11 has a heading and no visible options; the office
    // confirmed it reuses section 9's. One constant so they cannot drift.
    const choices = HVAC_CHECKLIST.filter(
      (i) => i.section === 'Overall condition' || i.section === 'Recommended action',
    );
    expect(choices).toHaveLength(2);
    for (const item of choices) expect(item.choices).toEqual([...HVAC_CONDITION_CHOICES]);
  });

  it('makes filter condition one answer rather than two contradictory ticks', () => {
    // The form prints "clean" and "dirty — replacement recommended" as separate
    // boxes. A filter cannot be both, and two booleans can say it is.
    const filter = HVAC_CHECKLIST.find((i) => i.label === 'Filter condition');
    expect(filter?.responseType).toBe('CHOICE');
    expect(filter?.choices).toHaveLength(2);
  });

  it('gives every item a unique label, because the label is its key', () => {
    // Stored uniquely on (organization, kind, label) for the org-wide rows, so
    // a duplicate would silently collapse two questions into one.
    const labels = HVAC_CHECKLIST.map((i) => i.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives a unit only to readings and choices only to choice items', () => {
    for (const item of HVAC_CHECKLIST) {
      if (item.responseType !== 'READING') expect(item.unit).toBeUndefined();
      if (item.responseType !== 'CHOICE') expect(item.choices).toBeUndefined();
      if (item.responseType === 'READING') expect(item.unit).toBeTruthy();
      if (item.responseType === 'CHOICE') expect(item.choices?.length).toBeGreaterThan(1);
    }
  });

  it('is mostly ticks, which is what the form mostly is', () => {
    const status = HVAC_CHECKLIST.filter((i) => i.responseType === 'STATUS');
    expect(status.length).toBe(47);
    expect(HVAC_CHECKLIST).toHaveLength(60);
  });
});
