import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TenantsPage from './page';

/** Tenancies from the office's Propertyware report. Everything invented. */

const hooks = vi.hoisted(() => ({ useTenants: vi.fn() }));
vi.mock('@/lib/queries', () => hooks);
const url = vi.hoisted(() => ({
  state: { page: 1, q: '', enrollment: '' },
  set: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [url.state, url.set, url.reset] }));

const tenant = (over: Record<string, unknown> = {}) => ({
  id: 'tenant-1',
  leaseName: 'Sam Example',
  sourceStatus: 'Active',
  startDate: null,
  endDate: null,
  tbpEnrollment: 'Yes',
  zone: 'Zone 1',
  managementPlan: null,
  hvacPlan: null,
  hvacFilterSizes: [],
  lastFilterDelivery: null,
  lastOccupiedInspection: null,
  addressLine1: '100 Example Way',
  city: 'Testville',
  state: 'TX',
  postalCode: '77000',
  building: { id: 'building-1', name: '100 Example Way', addressLine1: '100 Example Way' },
  ...over,
});

function mount(items = [tenant()]) {
  hooks.useTenants.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { items, total: items.length, page: 1, pageSize: 20, totalPages: 1 },
  });
  return render(<TenantsPage />);
}

beforeEach(() => {
  url.state = { page: 1, q: '', enrollment: '' };
  url.reset.mockReset();
});

describe('the tenants list', () => {
  it('opens the property a tenancy matched', () => {
    mount();

    const table = screen.getByRole('table', { name: 'Active tenancies' });
    expect(within(table).getByRole('link', { name: '100 Example Way' }).getAttribute('href')).toBe(
      '/properties/building-1',
    );
  });

  it('says so, and links nothing, when the address matched no property', () => {
    mount([tenant({ building: null })]);

    const table = screen.getByRole('table', { name: 'Active tenancies' });
    expect(within(table).queryByRole('link')).toBeNull();
    expect(within(table).getByText(/not matched to a property/)).toBeTruthy();
  });

  it('gives a way back from a filter that matched nothing', () => {
    url.state = { page: 1, q: 'nobody', enrollment: '' };
    mount([]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(url.reset).toHaveBeenCalled();
  });
});
