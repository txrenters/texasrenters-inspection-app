import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsoleShellProvider } from '@/components/console-shell-context';

import PropertyDetailPage from './page';

/**
 * The property page's header: whether the property is active, and whether a
 * visit can be booked from here. Everything invented.
 */

const hooks = vi.hoisted(() => ({ useProperty: vi.fn(), useInspections: vi.fn() }));
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
vi.mock('@/components/invoices/invoice-parts', () => ({ InvoicesCard: () => null }));
// The billing history has its own tests (billing-card.test.tsx).
vi.mock('@/components/invoices/billing-card', () => ({ BillingCard: () => null }));
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

function mount(item = property(), shell: 'classic' | 'jobber' = 'classic') {
  hooks.useProperty.mockReturnValue({ isError: false, data: item, refetch: vi.fn() });
  return render(
    <ConsoleShellProvider shell={shell}>
      <PropertyDetailPage />
    </ConsoleShellProvider>,
  );
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

/**
 * The page in the Jobber-style shell (the office, 2026-11-04: "we want the
 * features for familiarity"), headed and laid out as Jobber's client page.
 */
describe('in the Jobber-style shell', () => {
  beforeEach(() => {
    hooks.useInspections.mockReset();
    hooks.useInspections.mockReturnValue({
      isError: false,
      isLoading: false,
      data: {
        total: 12,
        items: [
          {
            id: 'insp-9',
            inspectionType: 'MOVE_OUT',
            status: 'SCHEDULED',
            scheduledAt: '2026-11-12T00:00:00.000Z',
            propertywareUnit: null,
            assignments: [{ isCurrent: true, technician: { displayName: 'Ada Lane' } }],
          },
        ],
      },
    });
  });

  it('heads the property as Jobber heads a client: its icon and an Active pill above the name', () => {
    mount(property(), 'jobber');
    expect(screen.getByText('Property', { selector: '.sr-only' })).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '100 Example Way' })).toBeTruthy();
  });

  it('offers "+ Create" by inspection type, each opening the form for this property', () => {
    permissions.granted = new Set(['inspections:manage']);
    mount(property(), 'jobber');
    fireEvent.pointerDown(screen.getByRole('button', { name: /Create/ }), { button: 0, pointerId: 1, pointerType: 'mouse' });

    expect(screen.getByRole('menuitem', { name: /Move-out/ }).getAttribute('href')).toBe(
      '/inspections/new?propertyId=building-1&type=MOVE_OUT',
    );
    expect(screen.getByRole('menuitem', { name: 'Another type…' }).getAttribute('href')).toBe(
      '/inspections/new?propertyId=building-1',
    );
  });

  it('lists the inspections at the property, asking only for this property, ten at a time', () => {
    mount(property(), 'jobber');
    expect(hooks.useInspections).toHaveBeenCalledWith({ propertyId: 'building-1', page: 1, pageSize: 10 });

    const work = screen.getByRole('region', { name: /Inspections/ });
    expect(within(work).getByRole('link', { name: /Move-out/ }).getAttribute('href')).toBe('/inspections/insp-9');
    // Twelve in all, one shown: the rest are a search of the list away.
    expect(within(work).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe(
      '/inspections?q=100%20Example%20Way&day=all',
    );
  });

  it('keeps the facts, as Jobber’s details tables', () => {
    mount(property(), 'jobber');
    const details = screen.getByLabelText('Property details');
    expect(within(details).getByText('Example Portfolio')).toBeTruthy();
    expect(within(screen.getByLabelText('Propertyware record')).getByText('pw-1')).toBeTruthy();
  });

  it('asks for nothing more in the classic console', () => {
    mount(property(), 'classic');
    expect(hooks.useInspections).not.toHaveBeenCalled();
    expect(screen.queryByText('Property', { selector: '.sr-only' })).toBeNull();
  });
});
