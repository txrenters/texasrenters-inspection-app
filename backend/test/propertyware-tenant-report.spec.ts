import {
  isTbpEnrolled,
  parseTenantReport,
  tenantExternalId,
} from '../src/integrations/propertyware/propertyware.tenant-report';

/**
 * The office's tenancy report — the only source that knows about the benefit
 * package, and the only one carrying a building address.
 *
 * Shapes here are taken from the live report (418 rows), not invented.
 */

const columns = [
  'Lease Name',
  'Status',
  'Start Date',
  'End Date',
  'Enrolled in Tenant Benefits Package',
  'Zone',
  'Management Plan',
  'HVAC Plan',
  'HVAC Filter Location Information',
  'HVAC Filter Size 1',
  'HVAC Filter Size 2',
  'HVAC Filter Size 3',
  'HVAC Filter Size 4',
  'Last Filter Delivery',
  'Last HVAC Inspection',
  'Last Occupied Inspection',
  'Building Address',
  'Building City',
  'Building State',
  'Building Zip',
].map((label, index) => ({ index: String(index), dataType: 'text', label }));

/** One real row, verbatim from the live report. */
const row = (overrides: Record<string, string> = {}) => ({
  '0': 'Abuah - Abuah',
  '1': 'Active',
  '2': '01/23/2025',
  '3': '01/19/2027',
  '4': 'Yes',
  '5': '2',
  '6': 'Full Service',
  '7': 'Not Completed',
  '8': 'Hallway ceiling',
  '9': '16x25x1',
  '10': 'N/A',
  '11': 'N/A',
  '12': 'N/A',
  '13': '04/09/2026 - Moses',
  '14': '',
  '15': '',
  '16': '6341 Del Monte Dr',
  '17': 'Houston',
  '18': 'TX',
  '19': '77057-3403',
  ...overrides,
});

const report = (records: Array<Record<string, string>>) => ({
  totalCount: records.length,
  columns,
  records,
});

describe('parsing the tenancy report', () => {
  it('reads a real row', () => {
    const [tenant] = parseTenantReport(report([row()]));
    expect(tenant).toMatchObject({
      leaseName: 'Abuah - Abuah',
      sourceStatus: 'Active',
      startDate: '2025-01-23',
      endDate: '2027-01-19',
      tbpEnrollment: 'Yes',
      zone: '2',
      hvacPlan: 'Not Completed',
      addressLine1: '6341 Del Monte Dr',
      postalCode: '77057-3403',
    });
  });

  it('drops the placeholders the office types into unused filter slots', () => {
    // All four columns always exist, so a home with one filter reads
    // "16x25x1, N/A, N/A, N/A". Keeping those would make every property look
    // like it has four filters, and put "N/A" in front of a technician.
    const [tenant] = parseTenantReport(report([row()]));
    expect(tenant!.hvacFilterSizes).toEqual(['16x25x1']);
  });

  /**
   * The placeholders were a deny-list of the ones somebody had seen: "n/a",
   * "none", "tbd", "unknown". Every value below is one the office had since
   * typed into the live report and none of them were on it, so they were stored
   * as filter sizes -- 295 cells reading "Not Completed", 31 reading "UPDATE",
   * 16 reading ".". The visit still said "Update filter sizes", because the
   * writer prints nothing it cannot find a size in; the damage was that
   * `hvacFilterSizes` was not empty, so every count of "which tenancies are
   * missing a size" came back wrong and nobody went looking.
   */
  it.each([
    ['Not Completed', '295 cells of it'],
    ['UPDATE', 'the office’s note to itself'],
    ['.', 'a cell somebody tabbed through'],
    ['Uknown', 'the misspelling the deny-list could never have held'],
    ['Hallway', 'the location typed into the size column'],
    ['Attic', 'the same again'],
  ])('does not store %s as a filter size (%s)', (junk) => {
    const [tenant] = parseTenantReport(report([row({ '9': junk, '10': junk, '11': '', '12': '' })]));
    expect(tenant!.hvacFilterSizes).toEqual([]);
  });

  it('keeps a size wherever it sits in the cell, and the note around it', () => {
    // The report writes a size with its unit label and the office's notes
    // around it, so anything anchored matches almost nothing here.
    const [tenant] = parseTenantReport(
      report([row({ '9': '16x20x1 (1/2 N Main)', '10': '20x25 MEDIA', '11': '20x30', '12': 'N/A' })]),
    );
    expect(tenant!.hvacFilterSizes).toEqual(['16x20x1 (1/2 N Main)', '20x25 MEDIA', '20x30']);
  });

  it('keeps a unit note that names no size, because a unit with no filter is an answer', () => {
    // "reusable window AC unit (no need to change - 1/4 N Main)" is how the
    // office records a unit with nothing to change. Drop it and `unitFilterSizes`
    // stops seeing that unit as spoken for, so it falls back to the building's
    // sizes and sends a technician to change next door's filter.
    const note = 'reusable window AC unit (no need to change - 1/4 N Main)';
    const [tenant] = parseTenantReport(report([row({ '9': '20x20x1 (N Main)', '10': note, '11': '', '12': '' })]));
    expect(tenant!.hvacFilterSizes).toEqual(['20x20x1 (N Main)', note]);
  });

  it('keeps the last filter delivery as written', () => {
    // "04/09/2026 - Moses" is a date *and* who delivered it. Parsing it into a
    // date would throw the person away, and the person is half the answer.
    const [tenant] = parseTenantReport(report([row()]));
    expect(tenant!.lastFilterDelivery).toBe('04/09/2026 - Moses');
  });

  it('follows the columns when they move', () => {
    // The failure this whole approach exists to avoid: the lease report was
    // read by position, somebody reordered it upstream, and it silently
    // returned zero rows for weeks.
    const reversed = [...columns].reverse();
    const [tenant] = parseTenantReport({ totalCount: 1, columns: reversed, records: [row()] });
    expect(tenant!.leaseName).toBe('Abuah - Abuah');
    expect(tenant!.addressLine1).toBe('6341 Del Monte Dr');
  });

  it('refuses a report with no building address rather than storing rows it cannot place', () => {
    // This is exactly what the *other* published report lacks, and why it
    // cannot be the tenant source.
    const withoutAddress = columns.filter((column) => column.label !== 'Building Address');
    expect(() =>
      parseTenantReport({ totalCount: 1, columns: withoutAddress, records: [row()] }),
    ).toThrow(/Building Address/);
  });

  it('tolerates an optional column disappearing', () => {
    // The office maintains this report. Losing 418 tenancies because the HVAC
    // filter column was renamed would be a bad trade for one field.
    const withoutHvac = columns.filter((column) => !column.label.startsWith('HVAC'));
    const [tenant] = parseTenantReport({ totalCount: 1, columns: withoutHvac, records: [row()] });
    expect(tenant!.leaseName).toBe('Abuah - Abuah');
    expect(tenant!.hvacFilterSizes).toEqual([]);
  });

  it('skips a row that identifies nothing', () => {
    expect(parseTenantReport(report([row({ '0': '', '16': '' })]))).toEqual([]);
  });

  it('carries the building id when the report has one', () => {
    // Added to the report after this sync shipped. Exact, so the sync prefers
    // it over matching the address: all 416 distinct ids in the live report
    // resolve, where address matching left nine rows unplaced.
    const withId = [...columns, { index: '21', dataType: 'text', label: 'Building Entity ID' }];
    const [tenant] = parseTenantReport({
      totalCount: 1,
      columns: withId,
      records: [{ ...row(), '21': '4652695552' }],
    });
    expect(tenant!.buildingExternalId).toBe('4652695552');
  });

  it('still parses a report without the id column', () => {
    // The column is optional: a report predating it must keep working, and the
    // address remains the fallback.
    const [tenant] = parseTenantReport(report([row()]));
    expect(tenant!.buildingExternalId).toBeNull();
    expect(tenant!.addressLine1).toBe('6341 Del Monte Dr');
    expect(tenant).toMatchObject({ unitExternalId: null, unitName: null });
  });

  /** Added for buildings of several units (the office, 2026-09-18), under whichever label the report uses. */
  it('carries the unit when the report names it', () => {
    const withUnit = [
      ...columns,
      { index: '21', dataType: 'text', label: 'Unit Entity ID' },
      { index: '22', dataType: 'text', label: 'Unit' },
    ];
    const [tenant] = parseTenantReport({
      totalCount: 1,
      columns: withUnit,
      records: [{ ...row(), '21': '9012', '22': '1/2' }],
    });
    expect(tenant).toMatchObject({ unitExternalId: '9012', unitName: '1/2' });
  });

  it('reads the unit under the label "Unit Name" too', () => {
    const [tenant] = parseTenantReport({
      totalCount: 1,
      columns: [...columns, { index: '21', dataType: 'text', label: 'Unit Name' }],
      records: [{ ...row(), '21': 'North' }],
    });
    expect(tenant!.unitName).toBe('North');
  });
});

describe('the derived identity', () => {
  it('is stable, so a re-sync updates rather than duplicates', () => {
    const a = tenantExternalId('Abuah - Abuah', '01/23/2025', '6341 Del Monte Dr');
    const b = tenantExternalId('Abuah - Abuah', '01/23/2025', '6341 Del Monte Dr');
    expect(a).toBe(b);
  });

  it('separates the same lease name at two properties', () => {
    // The report offers nothing else to tell them apart, which is why the
    // address is part of the key.
    expect(tenantExternalId('Smith - Smith', '01/01/2025', '1 Oak St')).not.toBe(
      tenantExternalId('Smith - Smith', '01/01/2025', '2 Elm St'),
    );
  });
});

describe('who counts as enrolled', () => {
  it('is only an explicit yes', () => {
    expect(isTbpEnrolled('Yes')).toBe(true);
    expect(isTbpEnrolled('yes')).toBe(true);
  });

  it('does not count "Not Verified" as enrolled', () => {
    // Twelve tenancies carry it, and it means nobody has checked — which is
    // neither yes nor no. Counting it either way would be inventing an answer
    // the office deliberately did not give.
    expect(isTbpEnrolled('Not Verified')).toBe(false);
    expect(isTbpEnrolled('No')).toBe(false);
    expect(isTbpEnrolled(null)).toBe(false);
  });
});
