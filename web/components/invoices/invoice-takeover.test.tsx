import { fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceTakeoverView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvoiceTakeoverSection } from './invoice-takeover-section';

/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8): what the cutover
 * waits on, the one button for whoever both makes invoices and runs the
 * integrations, asked once, and -- once taken over -- when, by whom, and an
 * undo while nothing changed since. Everything invented.
 */

const takeover = vi.hoisted(() => ({
  view: { current: null as InvoiceTakeoverView | null },
  takeOver: { mutate: vi.fn(), isPending: false },
  undo: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-takeover-queries', () => ({
  useInvoiceTakeover: () => ({ isLoading: false, data: takeover.view.current }),
  useInvoiceTakeoverActions: () => ({ takeOver: takeover.takeOver, undo: takeover.undo }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const check = (key: string, ok: boolean, blocking = true, detail: string | null = null) => ({ key, ok, blocking, label: `${key} label`, detail });

const BEFORE: InvoiceTakeoverView = {
  takenOverAt: null,
  takenOverBy: null,
  changesSince: 0,
  undoable: false,
  checks: [
    check('JOBBER_ANSWERS', true),
    check('INVOICES_READ', true),
    check('PAYMENTS_READ', true),
    check('FILES_COPIED', true, true, '1,240 of 1,240 kept.'),
    check('FILES_FAILED', false, false, '4 could not be copied.'),
    check('COMPANY_DETAILS', true, false),
  ] as InvoiceTakeoverView['checks'],
  ready: true,
  // Jobber is read one last time before the switch (2026-11-12).
  jobberConnected: true,
  failedFiles: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage', 'integrations:manage']);
  takeover.view.current = BEFORE;
});

describe('before the cutover', () => {
  it('lists what it waits on, and takes over only once asked, with the failed files left on purpose', () => {
    render(<InvoiceTakeoverSection />);
    const list = screen.getByRole('list', { name: 'What the switch waits on' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(list).toHaveTextContent('FILES_FAILED label (to know)');
    expect(list).toHaveTextContent('4 could not be copied.');

    fireEvent.click(screen.getByRole('button', { name: 'Make invoices in the console' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The console reads Jobber one last time.');
    const confirm = within(dialog).getByRole('button', { name: 'Make invoices in the console' });
    // Four files could not be copied: not until the office says they can be left.
    expect(confirm).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Leave the 4 files/ }));
    fireEvent.click(confirm);
    expect(takeover.takeOver.mutate).toHaveBeenCalledWith({ acceptFailedFiles: true }, expect.anything());
  });

  it('cannot be pressed while something holds it back', () => {
    takeover.view.current = { ...BEFORE, ready: false, checks: [check('FILES_COPIED', false, true, '1,200 of 1,240 kept; 40 still to copy.')] as InvoiceTakeoverView['checks'] };
    render(<InvoiceTakeoverSection />);
    expect(screen.getByRole('button', { name: 'Make invoices in the console' })).toBeDisabled();
    expect(screen.getByText('FILES_COPIED label')).toBeInTheDocument();
    expect(screen.getByText('(not yet)', { exact: false })).toBeInTheDocument();
  });

  it('is offered only to whoever both makes invoices and runs the integrations', () => {
    permissions.granted = new Set(['invoices:read', 'invoices:manage']);
    render(<InvoiceTakeoverSection />);
    expect(screen.queryByRole('button', { name: 'Make invoices in the console' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only whoever both makes invoices and runs the integrations/)).toBeInTheDocument();
  });
});

describe('without Jobber (2026-11-12)', () => {
  it('says nothing more is read from Jobber, and that each company’s invoices go to Xero as drafts', () => {
    takeover.view.current = { ...BEFORE, jobberConnected: false };
    render(<InvoiceTakeoverSection />);
    expect(screen.getByText(/Jobber is not connected, so nothing more is read from it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Make invoices in the console' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Jobber is no longer read. Invoices are made here, and each company’s go to Xero as drafts.');
    expect(dialog).not.toHaveTextContent('one last time');
  });
});

describe('after the cutover', () => {
  const after = (over: Partial<InvoiceTakeoverView>): InvoiceTakeoverView => ({
    ...BEFORE,
    checks: [],
    ready: false,
    takenOverAt: '2026-11-06T22:00:00.000Z',
    takenOverBy: { id: 'u1', displayName: 'System Admin' },
    ...over,
  });

  it('says when and by whom, and undoes it only once asked, while nothing changed since', () => {
    takeover.view.current = after({ undoable: true });
    render(<InvoiceTakeoverSection />);
    // 22:00 UTC is 4:00 PM in Texas.
    expect(screen.getByRole('region', { name: 'Make invoices in the console' })).toHaveTextContent(
      'The console has made the invoices since Nov 6, 2026, 4:00 PM, switched by System Admin.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Give it back' }));
    expect(takeover.undo.mutate).toHaveBeenCalled();
  });

  it('says why it can no longer be undone', () => {
    takeover.view.current = after({ undoable: false, changesSince: 3 });
    render(<InvoiceTakeoverSection />);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.getByText(/3 changes have been made to invoices here since/)).toBeInTheDocument();
  });
});
