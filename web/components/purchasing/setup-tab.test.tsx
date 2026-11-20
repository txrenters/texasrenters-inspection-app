import { DEFAULT_FILE_RULES, stepsFromLimit, type PurchasingSetup } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SetupTab } from './setup-tab';

/**
 * Purchasing > Setup, part 5a (2026-11-20): saved as you go, and only what
 * the office may keep. Every figure invented.
 */

const hooks = vi.hoisted(() => ({ usePurchasingSetup: vi.fn(), usePurchasingSetupEdits: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const SETUP: PurchasingSetup = {
  approvals: { steps: stepsFromLimit(50000, 2), emailApprovers: false, reapproveChangedOrders: false },
  numbers: [
    { kind: 'PR', label: 'Purchase requisition', prefix: 'PR-', digits: 5, next: 43 },
    { kind: 'PO', label: 'Purchase order', prefix: 'PO-', digits: 4, next: 34 },
  ],
  files: DEFAULT_FILE_RULES,
};
let saves: Record<'approvals' | 'files' | 'series', { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null }>;

beforeEach(() => {
  saves = { approvals: { mutate: vi.fn(), isPending: false, error: null }, files: { mutate: vi.fn(), isPending: false, error: null }, series: { mutate: vi.fn(), isPending: false, error: null } };
  hooks.usePurchasingSetupEdits.mockReturnValue(saves);
  hooks.usePurchasingSetup.mockReturnValue({ isLoading: false, isError: false, data: SETUP });
});

const pick = (label: string, option: string) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const section = (title: string) => screen.getByRole('region', { name: title });

describe('Purchasing Setup', () => {
  it('shows the steps, the switches, the numbers and the file rules as the office keeps them', () => {
    render(<SetupTab enabled />);
    expect(screen.getByText('System admin and Purchasing admin only')).toBeTruthy();
    const approvals = section('Approvals');
    expect(within(approvals).getAllByRole('row').map((row) => row.textContent)).toEqual([
      'FromUp toWho approvesQuotes neededReminderRemove',
      expect.stringContaining('$0.00'),
      expect.stringContaining('$500.01No limit'),
    ]);
    expect((screen.getByLabelText('Step 1: up to, in dollars') as HTMLInputElement).value).toBe('500.00');
    expect(within(section('Numbers')).getByText('PR-00043')).toBeTruthy();
    expect(within(section('Attachments')).getByRole('button', { name: 'File types' }).textContent).toContain('PDF, pictures (JPG, PNG, HEIC), Word, Excel');
  });

  it('saves a step as soon as a choice is made, and a typed top when its box is left', () => {
    render(<SetupTab enabled />);
    pick('Step 1: reminder', 'After 1 day');
    expect(saves.approvals.mutate).toHaveBeenLastCalledWith({ steps: [{ ...SETUP.approvals.steps[0], reminderDays: 1 }, SETUP.approvals.steps[1]], emailApprovers: false, reapproveChangedOrders: false });

    const top = screen.getByLabelText('Step 1: up to, in dollars');
    fireEvent.change(top, { target: { value: '1,000.00' } });
    expect(saves.approvals.mutate).toHaveBeenCalledTimes(1);
    fireEvent.blur(top);
    expect(saves.approvals.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ steps: [expect.objectContaining({ upToCents: 100000, reminderDays: 1 }), SETUP.approvals.steps[1]] }));

    fireEvent.click(screen.getByRole('switch', { name: 'Email the approver when one is sent' }));
    expect(saves.approvals.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ emailApprovers: true }));
  });

  it('says what is wrong with steps that cannot be kept, and saves none of it', () => {
    render(<SetupTab enabled />);
    pick('Step 2: who approves', 'Any Approver');
    expect(saves.approvals.mutate).toHaveBeenCalledTimes(1);
    // A larger amount approved by more people than a smaller one is refused, and not sent.
    pick('Step 1: who approves', 'Approver, any amount');
    expect(within(section('Approvals')).getByRole('status').textContent).toBe('Once a step needs somebody who may approve any amount, every higher step does too. Not saved.');
    expect(saves.approvals.mutate).toHaveBeenCalledTimes(1);
  });

  it('adds a step a thousand dollars above the one before it', () => {
    render(<SetupTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    expect(saves.approvals.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ steps: [SETUP.approvals.steps[0], expect.objectContaining({ upToCents: 150000, approver: 'ANY_APPROVER' }), SETUP.approvals.steps[1]] }));
  });

  it('moves a number only up, and saves a series when its box is left', () => {
    render(<SetupTab enabled />);
    const next = screen.getByLabelText('Purchase requisition: next number');
    fireEvent.change(next, { target: { value: '40' } });
    fireEvent.blur(next);
    expect(screen.getByText('A next number can only go up: it is 43 now.')).toBeTruthy();
    expect(saves.series.mutate).not.toHaveBeenCalled();

    fireEvent.change(next, { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Purchase requisition: prefix'), { target: { value: 'req-' } });
    fireEvent.blur(next);
    expect(within(section('Numbers')).getByText('REQ-00100')).toBeTruthy();
    expect(saves.series.mutate).toHaveBeenCalledWith({ kind: 'PR', input: { prefix: 'REQ-', digits: 5, next: 100 } });
  });

  it('saves the file rules: a choice when made, a count and an amount when their box is left', () => {
    render(<SetupTab enabled />);
    pick('Largest file', '10 MB');
    expect(saves.files.mutate).toHaveBeenLastCalledWith({ ...DEFAULT_FILE_RULES, maxBytes: 10_000_000 });

    const quote = screen.getByLabelText('Quote attached above, in dollars');
    fireEvent.change(quote, { target: { value: '500' } });
    fireEvent.blur(quote);
    expect(saves.files.mutate).toHaveBeenLastCalledWith(expect.objectContaining({ maxBytes: 10_000_000, quoteFileAboveCents: 50000 }));

    const most = screen.getByLabelText('Most files on one requisition');
    fireEvent.change(most, { target: { value: '0' } });
    fireEvent.blur(most);
    expect(within(section('Attachments')).getByRole('status').textContent).toBe('Most files is a whole number from 1 to 50. Not saved.');
    expect(saves.files.mutate).toHaveBeenCalledTimes(2);
  });
});
