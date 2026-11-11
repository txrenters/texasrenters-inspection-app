import { fireEvent, render, screen, within } from '@testing-library/react';
import type { XeroSendingView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroSendingPanel } from './xero-sending-panel';

/**
 * Sending invoices to Xero (2026-11-10, phase 3 of the Xero plan): turned on
 * only once nothing blocks it, and only after the office says yes; what Xero
 * refused stays in view with its reason. Everything invented.
 */

const actions = vi.hoisted(() => ({
  setEnabled: { mutate: vi.fn(), isPending: false },
  run: { mutate: vi.fn(), isPending: false },
  retry: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/xero-queries', () => ({ useXeroSendingActions: () => actions }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OFF: XeroSendingView = {
  tenantId: 'a1000000-0000-4000-8000-000000000001',
  enabled: false,
  changedAt: null,
  canWrite: true,
  projectsEnabled: false,
  blockers: [],
  counts: { sent: 0, failed: 0, notYet: 18, noCompany: 0, payments: { sent: 0, failed: 0 }, writeOffs: { sent: 0, failed: 0 }, projects: { done: 0, failed: 0 }, changedHere: 0 },
  lastRunAt: null,
  lastRunProblem: null,
  failures: [],
  paymentFailures: [],
  writeOffFailures: [],
  projectFailures: [],
  changedHere: [],
};

const ON: XeroSendingView = {
  ...OFF,
  enabled: true,
  changedAt: '2026-12-02T15:00:00.000Z',
  counts: { sent: 16, failed: 2, notYet: 0, noCompany: 3, payments: { sent: 9, failed: 1 }, writeOffs: { sent: 4, failed: 1 }, projects: { done: 0, failed: 0 }, changedHere: 0 },
  lastRunAt: '2026-12-02T17:50:00.000Z',
  failures: [
    {
      invoiceId: 'inv-1',
      number: '8440',
      clientName: '12 Example Lane',
      problem: 'Invoice # must be unique.',
      attempts: 1,
      lastAttemptAt: '2026-12-02T17:50:00.000Z',
      nextAttemptAt: '2026-12-02T18:50:00.000Z',
    },
    {
      invoiceId: 'inv-2',
      number: '8441',
      clientName: '14 Example Lane',
      problem: 'Its lines come to $175.00 and its total is $180.00, so it is not sent.',
      attempts: 1,
      lastAttemptAt: '2026-12-02T17:50:00.000Z',
      nextAttemptAt: null,
    },
  ],
  paymentFailures: [
    {
      paymentId: 'pay-1',
      invoiceId: 'inv-3',
      number: '8442',
      clientName: '16 Example Lane',
      amountCents: 17500,
      paidOn: '2026-12-03',
      problem: 'Choose the Xero account Zelle payments land in, under “Before anything is sent”.',
      attempts: 1,
      lastAttemptAt: '2026-12-02T17:50:00.000Z',
      nextAttemptAt: null,
    },
  ],
  writeOffFailures: [
    {
      invoiceId: 'inv-4',
      number: '8443',
      clientName: '18 Example Lane',
      amountCents: 6000,
      reversing: true,
      problem: 'Reopened here, but Xero would not take the write-off back: The credit note is reconciled',
      attempts: 2,
      lastAttemptAt: '2026-12-02T17:50:00.000Z',
      nextAttemptAt: '2026-12-02T23:50:00.000Z',
    },
  ],
};

const mount = (view: XeroSendingView, canManage = true) => render(<XeroSendingPanel canManage={canManage} sendFrom="2026-12-01" view={view} />);

beforeEach(() => vi.clearAllMocks());

describe('the sending panel', () => {
  it('turns on only after the office says yes, saying what it does', () => {
    mount(OFF);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(actions.setEnabled.mutate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/go to Xero as approved invoices, each under its property as a contact/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Xero emails nobody/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(actions.setEnabled.mutate).toHaveBeenCalledWith(true, expect.anything());
  });

  it('cannot be turned on while something blocks it', () => {
    mount({ ...OFF, blockers: ['Connect again, so Xero lets the console write contacts and invoices.'] });
    expect(screen.getByText('Connect again, so Xero lets the console write contacts and invoices.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  });

  it('shows what went and what Xero refused, with the reason and when it is tried again', () => {
    mount(ON);
    expect(screen.getByText('16')).toBeInTheDocument();
    const refused = screen.getByText('Invoice # must be unique.').closest('tr')!;
    expect(within(refused).getByText('#8440')).toBeInTheDocument();
    const held = screen.getByText(/Its lines come to \$175.00/).closest('tr')!;
    expect(within(held).getByText('When it changes')).toBeInTheDocument();
  });

  it('shows the payments in Xero and those refused, with why (2026-11-10)', () => {
    mount(ON);
    const payments = screen.getByLabelText('Payments');
    expect(within(payments).getByText('Payments in Xero').nextSibling).toHaveTextContent('9');
    expect(within(payments).getByText('Payments refused').nextSibling).toHaveTextContent('1');
    const refused = within(screen.getByRole('table', { name: 'Payments refused' })).getByText(/Zelle payments land in/).closest('tr')!;
    expect(within(refused).getByText(/^\$175\.00, /)).toBeInTheDocument();
    expect(within(refused).getByText('#8442')).toBeInTheDocument();
    expect(within(refused).getByText('When it changes')).toBeInTheDocument();
  });

  it('shows the bad debts written off, and the one Xero would not take back (2026-11-10)', () => {
    mount(ON);
    expect(within(screen.getByLabelText('Bad debts')).getByText('Written off in Xero').nextSibling).toHaveTextContent('4');
    const refused = within(screen.getByRole('table', { name: 'Bad debts refused' })).getByText(/would not take the write-off back/).closest('tr')!;
    expect(within(refused).getByText('#8443')).toBeInTheDocument();
    expect(refused).toHaveTextContent('$60.00 · taking back');
  });

  it('offers to try again when only a bad debt was refused', () => {
    mount({ ...ON, failures: [], counts: { ...ON.counts, failed: 0, payments: { sent: 9, failed: 0 } } });
    expect(screen.getByRole('button', { name: 'Try the refused again' })).toBeInTheDocument();
  });

  it('offers to try again when only a payment was refused', () => {
    mount({ ...ON, failures: [], counts: { ...ON.counts, failed: 0 } });
    expect(screen.getByRole('button', { name: 'Try the refused again' })).toBeInTheDocument();
  });

  it('sends now, tries the refused again, and turns off after asking', () => {
    mount(ON);
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(actions.run.mutate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try the refused again' }));
    expect(actions.retry.mutate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    expect(actions.setEnabled.mutate).toHaveBeenCalledWith(false, expect.anything());
  });

  it('offers no buttons to whoever does not run the integrations', () => {
    mount(ON, false);
    expect(screen.queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
    expect(screen.getByText('Invoice # must be unique.')).toBeInTheDocument();
  });

  it('says each invoice goes once, and lists those changed here since, to change in Xero (2026-11-12)', () => {
    mount({
      ...ON,
      counts: { ...ON.counts, changedHere: 2 },
      changedHere: [
        { invoiceId: 'inv-5', number: '8444', clientName: '20 Example Lane', voided: false, changedAt: '2026-12-02T17:50:00.000Z' },
        { invoiceId: 'inv-6', number: '8445', clientName: '22 Example Lane', voided: true, changedAt: '2026-12-02T17:40:00.000Z' },
      ],
    });
    expect(screen.getByText(/Each goes once: in Xero it is the office's/)).toBeInTheDocument();
    expect(screen.queryByText(/each change follows/)).not.toBeInTheDocument();
    expect(screen.getByText('Changed here since').nextSibling).toHaveTextContent('2');
    const table = screen.getByRole('table', { name: 'Changed here since they went to Xero' });
    const changed = within(table).getByText('20 Example Lane').closest('tr')!;
    expect(within(changed).getByRole('link', { name: '#8444' })).toHaveAttribute('href', '/invoices/inv-5');
    expect(changed).toHaveTextContent('Make the same change in Xero');
    expect(within(table).getByText('22 Example Lane').closest('tr')).toHaveTextContent('Voided here: void it in Xero too');
  });

  it('shows no changed-here list or count when nothing changed after it went', () => {
    mount(ON);
    expect(screen.queryByRole('table', { name: 'Changed here since they went to Xero' })).not.toBeInTheDocument();
    expect(screen.queryByText('Changed here since')).not.toBeInTheDocument();
  });

  describe('while each visit gets a project (2026-11-11)', () => {
    const PROJECTS: XeroSendingView = {
      ...ON,
      projectsEnabled: true,
      failures: [],
      counts: { ...ON.counts, failed: 0, payments: { sent: 0, failed: 0 }, writeOffs: { sent: 0, failed: 0 }, projects: { done: 12, failed: 1 } },
      projectFailures: [
        {
          inspectionId: 'visit-1',
          name: 'Ada: Move Out Inspection - 12.02.2026',
          problem: 'Its client has no contact in Xero yet.',
          attempts: 1,
          lastAttemptAt: '2026-12-02T17:50:00.000Z',
          nextAttemptAt: '2026-12-02T18:50:00.000Z',
        },
      ],
    };

    it('says invoices go as drafts, for the office to put each line on its project and approve', () => {
      mount(PROJECTS);
      expect(screen.getByText(/go to Xero as drafts, each visit with a project of its own: in Xero, put each line on its project/)).toBeInTheDocument();
      expect(screen.queryByText(/with the payments recorded against them/)).not.toBeInTheDocument();
    });

    it('shows the visits with a project and the projects Xero refused, and offers to try those again', () => {
      mount(PROJECTS);
      expect(within(screen.getByLabelText('Projects')).getByText('Visits with a project').nextSibling).toHaveTextContent('12');
      const refused = within(screen.getByRole('table', { name: 'Projects refused' })).getByText('Ada: Move Out Inspection - 12.02.2026').closest('tr')!;
      expect(refused).toHaveTextContent('Its client has no contact in Xero yet.');
      fireEvent.click(screen.getByRole('button', { name: 'Try the refused again' }));
      expect(actions.retry.mutate).toHaveBeenCalledTimes(1);
    });

    it('shows no project counts for a company that makes none', () => {
      mount(ON);
      expect(screen.queryByLabelText('Projects')).not.toBeInTheDocument();
    });
  });
});
