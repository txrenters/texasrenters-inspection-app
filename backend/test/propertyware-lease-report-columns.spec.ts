import {
  LEASE_REPORT_COLUMNS,
  leaseReportColumns,
} from '../src/integrations/propertyware/propertyware.schemas';
import { isActiveLeaseStatus } from '../src/integrations/propertyware/propertyware.client';

/**
 * Reading a Propertyware report by label instead of by position.
 *
 * The lease report's columns used to be pinned by index — `'9'` was the
 * building id, `'0'` was the status. Propertyware was then edited upstream so
 * index 9 became "Balance" and index 0 became "Lease Name", and nothing
 * failed. The parser read `$0.00` as a building id and `Abuah - Abuah` as a
 * status; `/^active/i` matched **0 of 448 rows**; every sync logged
 * ZERO_RECORDS_WARNING and the lease table stayed empty for weeks.
 *
 * A warning that fires when a report yields nothing reads exactly like a quiet
 * week, which is why this went unnoticed. The lesson is not "check the
 * warning" — it is that positional parsing of somebody else's report is
 * unsound, because the position is not part of any contract they keep.
 */

/** The report the parser was written against. */
const ORIGINAL = [
  { index: '0', label: 'Status' },
  { index: '4', label: 'Lease Name' },
  { index: '5', label: 'Start Date' },
  { index: '6', label: 'End Date' },
  { index: '7', label: 'Notice Given Date' },
  { index: '9', label: 'Building Entity ID' },
];

/** The report actually configured today, verified against production. */
const CURRENT = [
  'Lease Name',
  'Status',
  'Start Date',
  'End Date',
  'Move-In Date',
  'Monthly Rent',
  'Rent Unpaid',
  'Security Deposit Unpaid',
  'Deposit Held',
  'Balance',
  'Notice Given Date',
  'Scheduled Move Out Date',
  'Total Area',
].map((label, index) => ({ index: String(index), label }));

describe('resolving lease report columns', () => {
  it('finds every column in the report it was written for', () => {
    const { indexes, building, missing } = leaseReportColumns(ORIGINAL);
    expect(missing).toEqual([]);
    expect(building.id).toBe('9');
    expect(indexes.status).toBe('0');
  });

  it('follows the columns when they move rather than reading the old position', () => {
    // The failure this exists for. In the current report `Status` sits at index
    // 1, not 0 — positional parsing read the lease name instead and decided
    // nothing was active.
    const { indexes } = leaseReportColumns(CURRENT);
    expect(indexes.status).toBe('1');
    expect(indexes.leaseName).toBe('0');
    expect(indexes.startDate).toBe('2');
    // And nothing now reads index 9, which is a dollar amount.
    expect(Object.values(indexes)).not.toContain('9');
  });

  it('names what the configured report is actually missing', () => {
    // The real diagnosis: this report has no building column at all, so no
    // amount of correct parsing will make it produce leases. Saying so is the
    // point — 448 rows quietly becoming 0 told nobody anything.
    const { missing } = leaseReportColumns(CURRENT);
    expect(missing).toEqual(['Building Entity ID or Building Address']);
  });

  it('accepts an address in place of an id', () => {
    // Propertyware's report builder offers no `Building Entity ID` for this
    // report — only `Building Address` — so an address has to be enough, and
    // is resolved against the building list rather than used directly.
    const withAddress = [...CURRENT, { index: '13', label: 'Building Address' }];
    const { building, missing } = leaseReportColumns(withAddress);
    expect(missing).toEqual([]);
    expect(building.address).toBe('13');
    expect(building.id).toBeUndefined();
  });

  it('picks up the ZIP when the report carries one', () => {
    // Optional, but wanted: with a ZIP the match is street plus postal code.
    // Without it a street may only answer when it is unique organization-wide.
    const withBoth = [
      ...CURRENT,
      { index: '13', label: 'Building Address' },
      { index: '14', label: 'Building Zip' },
    ];
    expect(leaseReportColumns(withBoth).building.postalCode).toBe('14');
  });

  it('still refuses a report with neither', () => {
    const { missing } = leaseReportColumns(CURRENT);
    expect(missing.length).toBe(1);
  });

  it('ignores case and surrounding space, which Propertyware edits freely', () => {
    const { missing } = leaseReportColumns(
      [...Object.values(LEASE_REPORT_COLUMNS), 'Building Address'].map((label, index) => ({
        index: String(index),
        label: `  ${label.toUpperCase()} `,
      })),
    );
    expect(missing).toEqual([]);
  });

  it('reports every missing column at once', () => {
    // One failed sync should reveal the whole problem, not the first of it.
    const { missing } = leaseReportColumns([{ index: '0', label: 'Lease Name' }]);
    expect(missing).toEqual(
      expect.arrayContaining(['Status', 'Start Date', 'End Date']),
    );
    expect(missing).not.toContain('Lease Name');
  });

  it('refuses an empty column list rather than treating it as nothing missing', () => {
    // Every required label, plus the building pair that is neither present.
    expect(leaseReportColumns([]).missing.length).toBe(
      Object.keys(LEASE_REPORT_COLUMNS).length + 1,
    );
  });
});

describe('which lease statuses mean somebody is still in the property', () => {
  it('counts the plain and the notice-given', () => {
    expect(isActiveLeaseStatus('Active')).toBe(true);
    expect(isActiveLeaseStatus('Active - Notice Given')).toBe(true);
  });

  it('counts month-to-month and eviction, on the office’s instruction', () => {
    // Both were a judgement call rather than a guess: the tenant is still in
    // the property in each case, and a property with somebody in it is exactly
    // the one an occupied inspection is for.
    expect(isActiveLeaseStatus('Going MTM')).toBe(true);
    expect(isActiveLeaseStatus('Eviction')).toBe(true);
    expect(isActiveLeaseStatus('going mtm')).toBe(true);
  });

  it('does not count an ended tenancy', () => {
    expect(isActiveLeaseStatus('Closed')).toBe(false);
    expect(isActiveLeaseStatus('Former')).toBe(false);
    expect(isActiveLeaseStatus('')).toBe(false);
    expect(isActiveLeaseStatus(null)).toBe(false);
  });

  it('treats an unrecognised status as not live', () => {
    // The conservative direction, and stated so it is a decision rather than an
    // accident: a stale tenancy shown is visible and correctable, a live one
    // hidden is not — but this is also how the lease table came to be empty, so
    // a new status belongs in the list deliberately.
    expect(isActiveLeaseStatus('Pending Approval')).toBe(false);
  });
});
