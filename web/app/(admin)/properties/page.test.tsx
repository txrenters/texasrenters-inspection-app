import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PropertiesPage from './page';

const hooks = vi.hoisted(() => ({
  useProperties: vi.fn(),
  usePortfolios: vi.fn(),
  useAdminMutations: vi.fn(),
}));
vi.mock('@/lib/queries', () => hooks);
const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => permissions.allowed }) }));
const url = vi.hoisted(() => ({
  state: { page: 1, q: '', portfolio: '', occupancy: '' },
  set: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, url.reset] }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const property = (over: Record<string, unknown> = {}) => ({
  id: 'building-1',
  externalId: 'pw-1',
  name: '4412 Wicklow Bend',
  addressLine1: '4412 Wicklow Bend',
  city: 'Katy',
  state: 'TX',
  postalCode: '77494',
  sourceStatus: 'Occupied',
  sourceSystem: 'propertyware',
  isActive: true,
  lastSyncedAt: '2026-09-29T07:00:00.000Z',
  portfolio: { id: 'p-1', name: 'Nordway', externalId: 'pw-p-1' },
  totalArea: { label: '1,850 sq ft', source: 'PROPERTYWARE_BUILDING', derived: false },
  _count: { units: 1, inspections: 3 },
  ...over,
});

const createDemoProperty = {
  mutate: vi.fn(),
  isPending: false,
};

function mount(items = [property()]) {
  hooks.useProperties.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
  });
  hooks.usePortfolios.mockReturnValue({ isLoading: false, isError: false, data: { pages: [] } });
  hooks.useAdminMutations.mockReturnValue({ createDemoProperty });
  return render(<PropertiesPage />);
}

beforeEach(() => {
  createDemoProperty.mutate.mockReset();
  createDemoProperty.isPending = false;
  permissions.allowed = true;
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

/**
 * Adding a property the office can demonstrate the app with.
 *
 * Every other property on this page arrives from the Propertyware sync and is a
 * house somebody lives in. This button is the one exception, so the two things
 * worth pinning are that only somebody who can manage properties sees it, and
 * that a demo property is never mistakable for a managed one once it is there.
 */
describe('adding a demo property', () => {
  it('offers the button to somebody who can manage properties', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Add demo property' })).toBeTruthy();
  });

  it('hides it from somebody who cannot', () => {
    // Hidden rather than disabled: a button that cannot be pressed invites a
    // support question, and nothing on this page explains the permission.
    permissions.allowed = false;
    mount();
    expect(screen.queryByRole('button', { name: 'Add demo property' })).toBeNull();
  });

  it('sends no body, because the fixture is the server’s', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add demo property' }));

    expect(createDemoProperty.mutate).toHaveBeenCalledTimes(1);
    expect(createDemoProperty.mutate.mock.calls[0][0]).toBeUndefined();
  });

  it('says which property is ready, not just that something happened', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add demo property' }));

    const { onSuccess } = createDemoProperty.mutate.mock.calls[0][1];
    onSuccess({ name: 'Demo Property 1' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Demo Property 1 is ready to inspect.'));
  });

  it('repeats the server’s own refusal', async () => {
    // Both refusals say something actionable — the limit is reached, or it
    // already exists and the list needs a refresh. "Something went wrong" would
    // throw away the only two useful sentences here.
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add demo property' }));

    const { onError } = createDemoProperty.mutate.mock.calls[0][1];
    onError(new Error('This organization already holds 10 demo properties.'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This organization already holds 10 demo properties.'),
    );
  });

  it('cannot be pressed twice while the first is in flight', () => {
    createDemoProperty.isPending = true;
    mount();
    expect(screen.getByRole('button', { name: 'Adding…' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('telling a demo property apart from a real one', () => {
  it('badges the demo property', () => {
    mount([property(), property({ id: 'demo-1', name: 'Demo Property 1', sourceSystem: 'demo' })]);

    const table = screen.getByRole('table', { name: 'Active synchronized properties' });
    expect(within(table).getByText('Demo')).toBeTruthy();
  });

  it('leaves a synced property unbadged', () => {
    // The badge has to mean something. A page where every row said Demo would
    // be no better than one where none did.
    mount([property()]);

    const table = screen.getByRole('table', { name: 'Active synchronized properties' });
    expect(within(table).queryByText('Demo')).toBeNull();
  });
});
