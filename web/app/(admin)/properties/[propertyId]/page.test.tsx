import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PropertyDetailPage from './page';

/**
 * The property page's header: whether the property is active, and whether a
 * visit can be booked from here. Everything invented.
 */

const hooks = vi.hoisted(() => ({ useProperty: vi.fn() }));
vi.mock('@/lib/queries', () => hooks);
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ propertyId: 'building-1' }) }));
vi.mock('@/lib/url-state', () => ({ useUrlState: () => [{ tab: 'details' }, vi.fn()] }));
// The tabs' contents have their own tests; here they only have to be there.
vi.mock('@/components/floor-plan-manager', () => ({ FloorPlanManager: () => null }));
vi.mock('@/components/property-details-panel', () => ({ PropertyDetailsPanel: () => null }));
vi.mock('@/components/property-geofence-card', () => ({ PropertyGeofenceCard: () => null }));
vi.mock('@/components/property-service-card', () => ({ PropertyServiceCard: () => null }));
vi.mock('@/components/demo-property-delete-dialog', () => ({ DemoPropertyDeleteDialog: () => null }));

const property = (over: Record<string, unknown> = {}) => ({
  id: 'building-1',
  externalId: 'pw-1',
  name: '100 Example Way',
  addressLine1: '100 Example Way',
  city: 'Testville',
  state: 'TX',
  sourceStatus: 'Occupied',
  sourceSystem: 'propertyware',
  isActive: true,
  lastSyncedAt: '2026-09-29T07:00:00.000Z',
  portfolio: { id: 'p-1', name: 'Example Portfolio' },
  totalArea: { label: '1,850 sq ft', source: 'PROPERTYWARE_BUILDING', derived: false },
  leaseSummary: null,
  units: [],
  leases: [],
  _count: { units: 0, inspections: 0 },
  ...over,
});

function mount(item = property()) {
  hooks.useProperty.mockReturnValue({ isError: false, data: item, refetch: vi.fn() });
  return render(<PropertyDetailPage />);
}

beforeEach(() => {
  permissions.granted = new Set();
});

/**
 * The bug (console-development review, 2026-10-10): the Create inspection
 * button fell back to an "Inactive" badge for anybody without
 * inspections:manage, so an active property told a read-only reader it was
 * inactive.
 */
describe('active or not', () => {
  it('does not call an active property inactive for somebody who cannot book', () => {
    mount();

    expect(screen.queryByText('Inactive')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create inspection' })).toBeNull();
  });

  it('offers Create inspection on an active property to somebody who can book', () => {
    permissions.granted = new Set(['inspections:manage']);
    mount();

    expect(screen.getByRole('link', { name: 'Create inspection' }).getAttribute('href')).toBe(
      '/inspections/new?propertyId=building-1',
    );
    expect(screen.queryByText('Inactive')).toBeNull();
  });

  it('says an inactive property is inactive, to everybody, and offers no booking', () => {
    permissions.granted = new Set(['inspections:manage']);
    mount(property({ isActive: false }));

    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create inspection' })).toBeNull();
  });
});

describe('the facts and the lists', () => {
  it('shows the exact sync time on hover, not the raw timestamp', () => {
    mount();

    const synced = screen.getByText('Last synchronized').parentElement!.querySelector('dd')!;
    expect(synced.getAttribute('title')).not.toBe('2026-09-29T07:00:00.000Z');
    expect(synced.getAttribute('title')).toMatch(/2026/);
  });

  it('says plainly when no units or leases have synchronized', () => {
    mount();

    expect(screen.getByText('No active units have synchronized for this property.')).toBeTruthy();
    expect(
      screen.getByText('No relevant active leases were returned by the last synchronization.'),
    ).toBeTruthy();
  });
});
