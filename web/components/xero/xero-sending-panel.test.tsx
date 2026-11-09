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
  enabled: false,
  changedAt: null,
  canWrite: true,
  blockers: [],
  counts: { sent: 0, failed: 0, notYet: 18 },
  lastRunAt: null,
  lastRunProblem: null,
  failures: [],
};

const ON: XeroSendingView = {
  ...OFF,
  enabled: true,
  changedAt: '2026-12-02T15:00:00.000Z',
  counts: { sent: 16, failed: 2, notYet: 0 },
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
});
