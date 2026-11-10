import { fireEvent, render, screen, within } from '@testing-library/react';
import type { XeroCheckView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroCheckPanel } from './xero-check-panel';

/**
 * Checking a month of a company's invoices against Xero (2026-11-10, phase 5):
 * the latest check from the console's record, and Check now for whoever runs
 * the integrations. Everything invented.
 */

const TENANT = 'a2000000-0000-4000-8000-000000000002';
const hooks = vi.hoisted(() => ({
  check: { current: undefined as unknown },
  asked: [] as string[],
  run: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/xero-queries', () => ({
  useXeroCheck: (_tenantId: string, month: string) => {
    hooks.asked.push(month);
    return { isLoading: false, isError: false, data: hooks.check.current, refetch: vi.fn() };
  },
  useRunXeroCheck: () => hooks.run,
}));
vi.mock('@/lib/clock', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), businessToday: () => '2026-11-20' }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const NEVER: XeroCheckView = {
  tenantId: TENANT,
  month: '2026-11',
  ranAt: null,
  ranBy: null,
  counts: null,
  differences: [],
  truncated: false,
  calls: 0,
  sendFrom: '2026-11-01',
};

const CHECKED: XeroCheckView = {
  ...NEVER,
  ranAt: '2026-11-20T17:00:00.000Z',
  ranBy: 'Office Coordinator',
  calls: 2,
  counts: { console: 40, xero: 41, matching: 37, different: 1, notSent: 1, missingInXero: 1, onlyInXero: 2 },
  differences: [
    { kind: 'PAID', invoiceId: 'inv-1', number: '8440', clientName: '12 Example Lane', here: '$175.00 paid', xero: '$0.00 paid' },
    { kind: 'ONLY_IN_XERO', invoiceId: null, number: 'INV-0099', clientName: 'Walk-in client', here: 'Not in the console', xero: '$60.00, approved, owing' },
  ],
};

const mount = (canManage = true) => render(<XeroCheckPanel canManage={canManage} name="Example Pest Co" tenantId={TENANT} />);

beforeEach(() => {
  vi.clearAllMocks();
  hooks.asked = [];
  hooks.check.current = NEVER;
});

describe('checking a month against Xero', () => {
  it('starts on this month, says it has not been checked, and asks Xero only when told to', () => {
    mount();
    expect(screen.getByRole('combobox', { name: 'Month to check' })).toHaveTextContent('November 2026');
    expect(screen.getByText('November 2026 has not been checked yet.')).toBeInTheDocument();
    expect(hooks.run.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(hooks.run.mutate).toHaveBeenCalledWith('2026-11', expect.anything());
  });

  it('shows what was compared and each difference, the console’s invoices opening their page', () => {
    hooks.check.current = CHECKED;
    mount();
    expect(screen.getByText(/Checked .* by Office Coordinator, 2 calls to Xero\./)).toBeInTheDocument();
    const counts = screen.getByLabelText('What was compared');
    expect(within(counts).getByText('Only in Xero').nextSibling).toHaveTextContent('2');
    const table = screen.getByRole('table', { name: 'Differences with Xero' });
    const paid = within(table).getByText('Paid differs').closest('tr')!;
    expect(within(paid).getByRole('link', { name: '#8440' })).toHaveAttribute('href', '/invoices/inv-1');
    expect(within(paid).getByText('$175.00 paid')).toBeInTheDocument();
    const theirs = within(table).getByText('Only in Xero').closest('tr')!;
    expect(within(theirs).queryByRole('link')).not.toBeInTheDocument();
    expect(within(theirs).getByText('$60.00, approved, owing')).toBeInTheDocument();
  });

  it('says so when the console and Xero agree', () => {
    hooks.check.current = { ...CHECKED, differences: [], counts: { ...CHECKED.counts!, different: 0, notSent: 0, missingInXero: 0, onlyInXero: 0 } };
    mount();
    expect(screen.getByText('The console and Xero agree for November 2026.')).toBeInTheDocument();
  });

  it('says a month before the start date expects nothing from the console', () => {
    hooks.check.current = { ...CHECKED, sendFrom: '2026-12-01' };
    mount();
    expect(screen.getByText(/the start date, the console sends nothing: only what Xero has is listed/)).toBeInTheDocument();
  });

  it('reads another month’s check when one is chosen', () => {
    mount();
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Month to check' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('option', { name: 'October 2026' }));
    expect(hooks.asked.at(-1)).toBe('2026-10');
  });

  it('is read, not run, by whoever does not run the integrations', () => {
    hooks.check.current = CHECKED;
    mount(false);
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Differences with Xero' })).toBeInTheDocument();
  });
});
