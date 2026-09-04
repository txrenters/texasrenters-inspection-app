import {
  LEASE_REPORT_COLUMNS,
  leaseReportColumns,
} from '../src/integrations/propertyware/propertyware.schemas';

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
    const { indexes, missing } = leaseReportColumns(ORIGINAL);
    expect(missing).toEqual([]);
    expect(indexes.buildingId).toBe('9');
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
    expect(missing).toEqual(['Building Entity ID']);
  });

  it('ignores case and surrounding space, which Propertyware edits freely', () => {
    const { missing } = leaseReportColumns(
      Object.values(LEASE_REPORT_COLUMNS).map((label, index) => ({
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
      expect.arrayContaining(['Status', 'Start Date', 'End Date', 'Building Entity ID']),
    );
    expect(missing).not.toContain('Lease Name');
  });

  it('refuses an empty column list rather than treating it as nothing missing', () => {
    expect(leaseReportColumns([]).missing.length).toBe(
      Object.keys(LEASE_REPORT_COLUMNS).length,
    );
  });
});
