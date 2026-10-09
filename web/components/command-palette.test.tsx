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

const page = <T,>(items: T[]) => ({ items, total: items.length, page: 1, pageSize: 5, totalPages: 1 });

function answer(path: string) {
  if (path.startsWith('/api/v1/admin/inspections'))
    return page([
      {
        id: 'inspection-7',
        inspectionType: 'MOVE_OUT',
        scheduledAt: '2026-10-07T00:00:00.000Z',
        propertywareBuilding: { id: 'b-1', name: '18919 Summer Farm Trl' },
        propertywareUnit: null,
        assignments: [{ isCurrent: true, technician: { displayName: 'Amy Wilson' } }],
      },
    ]);
  if (path.startsWith('/api/v1/admin/properties'))
    return page([{ id: 'property-3', name: '9905 Brookview Dr', addressLine1: '9905 Brookview Dr', city: 'Austin' }]);
  if (path.startsWith('/api/v1/admin/technicians'))
    return page([{ id: 'tech-amy', displayName: 'Amy Wilson', email: 'amy@example.test' }]);
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
  it('finds inspections, properties and technicians by what was typed', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search inspections, properties/), {
      target: { value: 'amy' },
    });

    // The inspection says what it is, when, and who is on it.
    expect(await screen.findByText('18919 Summer Farm Trl')).toBeInTheDocument();
    expect(screen.getByText(/Move out · .* · Amy Wilson/i)).toBeInTheDocument();
    expect(screen.getByText('9905 Brookview Dr')).toBeInTheDocument();
    expect(screen.getByText('amy@example.test')).toBeInTheDocument();
    expect(asked()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/api\/v1\/admin\/inspections\?.*search=amy/),
        expect.stringMatching(/^\/api\/v1\/admin\/properties\?.*search=amy/),
        expect.stringMatching(/^\/api\/v1\/admin\/technicians\?.*search=amy/),
      ]),
    );
    expect(asked().every((path) => path.includes('pageSize=5'))).toBe(true);

    fireEvent.click(screen.getByText('18919 Summer Farm Trl'));
    expect(router.push).toHaveBeenCalledWith('/inspections/inspection-7');
  });

  it('asks only for what the account may read', async () => {
    granted.keys = new Set(['inspections:read']);
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search inspections, properties/), {
      target: { value: 'amy' },
    });

    expect(await screen.findByText('18919 Summer Farm Trl')).toBeInTheDocument();
    expect(asked()).toHaveLength(1);
    expect(asked()[0]).toMatch(/^\/api\/v1\/admin\/inspections/);
  });

  it('does not ask the server about a single letter', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search inspections, properties/), {
      target: { value: 'a' },
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api).not.toHaveBeenCalled();
  });
});

describe('the account and theme commands', () => {
  // They vanished the moment anything was typed (console-development), so
  // "dark" or "sign out" found nothing.
  it('are found by what was typed, like the pages', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Search…/ }));
    const field = screen.getByPlaceholderText(/Search inspections, properties/);

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
