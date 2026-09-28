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
const permissions = vi.hoisted(() => ({ granted: new Set(['properties:manage']) }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }),
}));
/**
 * The dialog is the inspection dialog's sibling and has its own reasoning to
 * test; here it stands in for itself so these tests are about the page — which
 * property was handed over, and whether a control appeared at all.
 */
vi.mock('@/components/demo-property-delete-dialog', () => ({
  DemoPropertyDeleteDialog: ({ property }: { property: { name: string; inspectionCount: number } }) => (
    <div data-testid="delete-dialog">{`${property.name} · ${property.inspectionCount}`}</div>
  ),
}));
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

const demo = (over: Record<string, unknown> = {}) =>
  property({
    id: 'demo-1',
    name: 'Demo Property 1',
    sourceSystem: 'demo',
    _count: { units: 0, inspections: 0 },
    ...over,
  });

beforeEach(() => {
  createDemoProperty.mutate.mockReset();
  createDemoProperty.isPending = false;
  permissions.granted = new Set(['properties:manage']);
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
    permissions.granted = new Set();
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

/**
 * The bin appears for demo properties and nothing else.
 *
 * The portfolio has 570 synced properties and no endpoint that deletes one, so
 * the risk here is not a failed request — it is a control that implies deleting
 * a real property is a thing that could be arranged.
 */
describe('deleting a demo property', () => {
  it('offers a bin on the demo row', () => {
    mount([property(), demo()]);
    expect(screen.getByRole('button', { name: 'Delete Demo Property 1' })).toBeTruthy();
  });

  it('offers nothing on a synced row', () => {
    mount([property()]);
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
  });

  it('offers nothing at all without properties:manage', () => {
    permissions.granted = new Set();
    mount([demo()]);
    expect(screen.queryByRole('button', { name: 'Delete Demo Property 1' })).toBeNull();
  });

  it('opens the dialog on the property that was clicked', () => {
    // Two demo properties is the case the confirmation exists for, so the page
    // has to hand over the right one.
    mount([demo(), demo({ id: 'demo-2', name: 'Demo Property 2' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo Property 2' }));

    expect(screen.getByTestId('delete-dialog').textContent).toContain('Demo Property 2');
  });

  it('tells the dialog how many inspections are at stake', () => {
    // The dialog decides whether to require the name typed from this number, so
    // a row that dropped it would silently downgrade the confirmation.
    mount([demo({ _count: { units: 0, inspections: 3 } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo Property 1' }));

    expect(screen.getByTestId('delete-dialog').textContent).toContain('· 3');
  });

  it('shows no dialog until the bin is clicked', () => {
    mount([demo()]);
    expect(screen.queryByTestId('delete-dialog')).toBeNull();
  });
});

describe('telling a demo property apart from a real one', () => {
  it('badges the demo property', () => {
    mount([property(), demo()]);

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
