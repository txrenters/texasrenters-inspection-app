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
