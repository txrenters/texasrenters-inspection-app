import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from './command-palette';
import { PageSearchProvider, useProvidePageSearch } from './page-search';

/**
 * The header's search (the office, 2026-10-07): on a list page it is that
 * list's search -- the second box under it was the same control twice -- and
 * ⌘K finds the records themselves, not only the pages.
 */

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api,
}));
const granted = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ signOut: vi.fn() }),
  usePermissions: () => ({ has: (key: string) => granted.keys.has(key) }),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

/** What the server found: only the kinds with a hit, as it answers. */
const FOUND = {
  groups: [
    {
      kind: 'inspection',
      hits: [{ id: 'inspection-7', targetId: 'inspection-7', title: '18919 Summer Farm Trl', detail: 'Move out · Oct 7, 2026 · Amy Wilson' }],
    },
    { kind: 'property', hits: [{ id: 'property-3', targetId: 'property-3', title: '9905 Brookview Dr', detail: '9905 Brookview Dr · Austin' }] },
    {
      kind: 'tenant',
      hits: [
        { id: 'tenant-1', targetId: 'property-3', title: 'Robin Vale', detail: '9905 Brookview Dr · Austin' },
        { id: 'tenant-2', targetId: null, title: 'Robin Vance', detail: '' },
      ],
    },
    { kind: 'invoice', hits: [{ id: 'invoice-9', targetId: 'invoice-9', title: 'Invoice #8439 · 100 Example Way', detail: '$39.99 · Oct 21, 2026' }] },
    { kind: 'payment', hits: [{ id: 'payment-2', targetId: 'payment-2', title: 'Payment $39.99 · 100 Example Way', detail: 'Nov 2, 2026 · Check' }] },
    { kind: 'requisition', hits: [{ id: 'pr-1', targetId: 'pr-1', title: 'PR-00043 · Filters for December', detail: 'Submitted · Ada Lane' }] },
    { kind: 'purchaseOrder', hits: [{ id: 'po-1', targetId: 'po-1', title: 'PO-0009 · Example Supply Co', detail: 'Sent · Bill B-7781' }] },
    { kind: 'stockItem', hits: [{ id: 'item-1', targetId: 'item-1', title: 'FLT-0012 · Filter 16x25x1', detail: 'Counted by the box' }] },
    { kind: 'vendor', hits: [{ id: 'vendor-1', targetId: null, title: 'Example Supply Co', detail: 'V-00003' }] },
    { kind: 'technician', hits: [{ id: 'tech-amy', targetId: 'tech-amy', title: 'Amy Wilson', detail: 'amy@example.test' }] },
    // A kind added to the server after this build of the console.
    { kind: 'somethingNewer', hits: [{ id: 'new-1', targetId: 'new-1', title: 'Not drawn', detail: '' }] },
  ],
};

function answer(path: string) {
  if (path.startsWith('/api/v1/admin/search?')) return FOUND;
  throw new Error(`unexpected ${path}`);
}

/** A list page, as far as the header is concerned. */
function ListPage({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('');
  useProvidePageSearch({
    label: 'Search move-out inspections',
    placeholder: 'Search move-out inspections…',
    value,
    onChange: (next) => {
      setValue(next);
      onChange(next);
    },
  });
  return null;
}

function mount(children?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageSearchProvider>
        <CommandPalette />
        {children}
      </PageSearchProvider>
    </QueryClientProvider>,
  );
}

const asked = () => api.mock.calls.map(([path]) => String(path));

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (path: string) => answer(path));
  router.push.mockReset();
  granted.keys = new Set(['inspections:read', 'properties:read', 'technicians:read']);
});

describe('the search for records', () => {
  const search = (text: string) => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search addresses, invoice and order numbers/), { target: { value: text } });
  };

  it('finds inspections, properties and technicians by what was typed', async () => {
    search('amy');

    // The inspection says what it is, when, and who is on it.
    expect(await screen.findByText('18919 Summer Farm Trl')).toBeInTheDocument();
    expect(screen.getByText(/Move out · .* · Amy Wilson/i)).toBeInTheDocument();
    expect(screen.getByText('9905 Brookview Dr')).toBeInTheDocument();
    expect(screen.getByText('amy@example.test')).toBeInTheDocument();

    fireEvent.click(screen.getByText('18919 Summer Farm Trl'));
    expect(router.push).toHaveBeenCalledWith('/inspections/inspection-7');
  });

  // The office (2026-11-24): nothing added since October could be found -- not
  // an invoice by its number, a requisition, a purchase order, a stock item.
  it.each([
    ['Invoice #8439 · 100 Example Way', '/invoices/invoice-9'],
    ['Payment $39.99 · 100 Example Way', '/payments/payment-2'],
    ['PR-00043 · Filters for December', '/purchasing/requisitions/pr-1'],
    ['PO-0009 · Example Supply Co', '/purchasing/orders/po-1'],
    ['FLT-0012 · Filter 16x25x1', '/inventory/items/item-1'],
    // No page of their own: a tenant opens their property, or the Tenants list
    // narrowed to them; a vendor opens the vendors.
    ['Robin Vale', '/properties/property-3'],
    ['Robin Vance', '/tenants?q=Robin+Vance'],
    ['Example Supply Co', '/inventory?tab=vendors'],
  ])('finds %s, and opens it', async (title, href) => {
    search('8439');

    fireEvent.click(await screen.findByText(title));
    expect(router.push).toHaveBeenCalledWith(href);
  });

  it('lists each kind under its own heading, and leaves out a kind it does not know', async () => {
    search('8439');

    expect(await screen.findByText('Invoices')).toBeInTheDocument();
    for (const heading of ['Inspections', 'Properties', 'Tenants', 'Payments', 'Requisitions', 'Purchase orders', 'Stock items', 'Vendors', 'Technicians'])
      expect(screen.getByText(heading)).toBeInTheDocument();
    expect(screen.queryByText('Not drawn')).toBeNull();
  });

  it('asks once a search, whatever the account may read: the server decides what it is answered with', async () => {
    granted.keys = new Set();
    search('#8439');

    expect(await screen.findByText('Invoice #8439 · 100 Example Way')).toBeInTheDocument();
    expect(asked()).toEqual(['/api/v1/admin/search?q=%238439']);
  });

  it('does not ask the server about a single letter', async () => {
    search('a');

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api).not.toHaveBeenCalled();
  });
});

describe('the pages that are not in the sidebar', () => {
  const type = (text: string) => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search addresses, invoice and order numbers/), { target: { value: text } });
  };

  it('are found by name, for an account that may open them', () => {
    granted.keys = new Set(['invoices:read', 'purchasing:request']);
    type('report');
    fireEvent.click(screen.getByText('Invoice reports'));
    expect(router.push).toHaveBeenCalledWith('/invoices/reports');
  });

  it('are not offered to an account that may not', () => {
    granted.keys = new Set(['invoices:read']);
    type('new');
    // Making an invoice is a permission of its own, and so is asking for a purchase.
    expect(screen.queryByText('New invoice')).toBeNull();
    expect(screen.queryByText('New requisition')).toBeNull();
  });
});

describe('the account and theme commands', () => {
  // They vanished the moment anything was typed (console-development), so
  // "dark" or "sign out" found nothing.
  it('are found by what was typed, like the pages', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    const field = screen.getByPlaceholderText(/Search addresses, invoice and order numbers/);

    fireEvent.change(field, { target: { value: 'dark' } });
    expect(await screen.findByRole('option', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Light' })).toBeNull();

    fireEvent.change(field, { target: { value: 'sign out' } });
    expect(await screen.findByRole('option', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Dark' })).toBeNull();
  });

  it('are all there before anything is typed', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    for (const name of ['Profile', 'Sign out', 'Light', 'Dark', 'System'])
      expect(screen.getByRole('option', { name })).toBeInTheDocument();
  });
});

describe('the shortcut it shows', () => {
  it('is Ctrl K away from a Mac, where the office presses Ctrl', () => {
    mount();
    expect(screen.getByRole('button', { name: /Search…/ })).toHaveTextContent('Ctrl K');
    expect(screen.getByRole('button', { name: /Search…/ })).not.toHaveTextContent('⌘K');
  });
});

describe('a list page’s search, in the header', () => {
  it('becomes the header’s field while the list is open, and gives it back after', async () => {
    const onChange = vi.fn();
    const { rerender } = mount(<ListPage onChange={onChange} />);

    const field = await screen.findByRole('searchbox', { name: 'Search move-out inspections' });
    expect(screen.queryByRole('button', { name: /Search…/ })).toBeNull();
    fireEvent.change(field, { target: { value: 'Summer Farm' } });
    expect(onChange).toHaveBeenLastCalledWith('Summer Farm');
    // The record search stays a key away.
    expect(screen.getByRole('button', { name: 'Search everything' })).toBeInTheDocument();

    const client = new QueryClient();
    rerender(
      <QueryClientProvider client={client}>
        <PageSearchProvider>
          <CommandPalette />
        </PageSearchProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Search…/ })).toBeInTheDocument());
  });
});

describe('opening the search', () => {
  /** Jobber's key for its search, so the office's habit works here too. */
  it('opens on "/" from anywhere on the page', () => {
    mount();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByPlaceholderText(/Search addresses, invoice and order numbers/)).toBeVisible();
  });

  it('leaves "/" alone while somebody is typing in a field', () => {
    mount(<input aria-label="A note" />);
    fireEvent.keyDown(screen.getByLabelText('A note'), { key: '/' });
    expect(screen.queryByPlaceholderText(/Search addresses, invoice and order numbers/)).toBeNull();
  });

  it('is drawn as Jobber’s search box in the Jobber-style shell', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PageSearchProvider>
          <CommandPalette variant="jobber" />
        </PageSearchProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Press / to search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search addresses, invoice and order numbers/)).toBeVisible();
  });
});
