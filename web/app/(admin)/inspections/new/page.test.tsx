import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NewInspectionPage from './page';

/**
 * Which areas an occupied inspection offers to walk.
 *
 * The form listed every approved area on the property. The server scopes an
 * inspection with `layoutAreasFor`, which is a smaller set — it drops the ones
 * that are not rooms. An HVAC visit's subjects live on the property as
 * `SYSTEM` areas, so "AC filters", "Filters", "A/C unit", "Thermostat" and
 * "Attic" were offered as rooms to walk, on a form for a job whose phone has a
 * dedicated AC Filter Change screen for that work.
 *
 * And because the form sends `areaIds` only when the selection is a genuine
 * subset, the disagreement stayed invisible until somebody cleared a single
 * area — at which point the ids went up explicitly and came back
 * "Select only approved areas belonging to this property", on a form where
 * every area shown did belong to the property.
 */

const queries = vi.hoisted(() => ({
  useProperty: vi.fn(),
  usePortfolios: vi.fn(),
  usePropertyOptions: vi.fn(),
  useUnits: vi.fn(),
  usePropertyAreas: vi.fn(),
  useLeases: vi.fn(),
  useTechnicians: vi.fn(),
  useAdminMutations: vi.fn(),
  useJobberBookingContext: vi.fn(),
}));

vi.mock('@/lib/queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...queries };
});

const address = vi.hoisted(() => ({ search: 'type=OCCUPIED' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  // `?type=OCCUPIED` is how the office reaches this form from the Occupied
  // section, and it is the only kind that offers a choice of areas at all --
  // a move-in or move-out always covers the whole layout, so the picker this
  // is about is not rendered for them.
  useSearchParams: () => new URLSearchParams(address.search),
}));

const idle = { data: undefined, isLoading: false, isError: false };
const list = (data: unknown[]) => ({ ...idle, data });
/** Portfolios and properties are paged; the page reads `data.pages`. */
const paged = (items: unknown[]) => ({ ...idle, data: { pages: [{ items }] } });

/** The real areas of the property where this was reported. */
const AREAS = [
  { id: 'a1', name: 'Kitchen', status: 'APPROVED', source: 'STANDARD_TEMPLATE', unitId: null },
  { id: 'a2', name: 'Main Bedroom', status: 'APPROVED', source: 'STANDARD_TEMPLATE', unitId: null },
  { id: 'a3', name: 'AC filters', status: 'APPROVED', source: 'SYSTEM', unitId: null },
  { id: 'a4', name: 'Filters', status: 'APPROVED', source: 'SYSTEM', unitId: null },
  { id: 'a5', name: 'A/C unit', status: 'APPROVED', source: 'SYSTEM', unitId: null },
  { id: 'a6', name: 'Thermostat', status: 'APPROVED', source: 'SYSTEM', unitId: null },
  { id: 'a7', name: 'Attic', status: 'APPROVED', source: 'SYSTEM', unitId: null },
  // A technician added this one on site. It IS a room, and it stays.
  { id: 'a8', name: 'Bathroom 2', status: 'APPROVED', source: 'TECHNICIAN', unitId: null },
  // Never offered regardless: an administrator has not approved it yet.
  { id: 'a9', name: 'Shed', status: 'DRAFT', source: 'MANUAL', unitId: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  address.search = 'type=OCCUPIED';
  queries.useProperty.mockReturnValue(idle);
  queries.usePortfolios.mockReturnValue(paged([]));
  queries.usePropertyOptions.mockReturnValue(paged([]));
  queries.useUnits.mockReturnValue({ ...idle, data: { items: [] } });
  queries.useLeases.mockReturnValue({ ...idle, data: { items: [] } });
  queries.useTechnicians.mockReturnValue({ ...idle, data: { items: [], total: 0 } });
  queries.useJobberBookingContext.mockReturnValue(idle);
  queries.useAdminMutations.mockReturnValue({
    createInspection: { mutateAsync: vi.fn(), isPending: false },
    createFallbackPropertyArea: { mutateAsync: vi.fn(), isPending: false },
  });
  queries.usePropertyAreas.mockReturnValue(list(AREAS));
});

/** The checkbox for an area, or null when the form does not offer it. */
const offered = (name: string) => screen.queryByRole('checkbox', { name });

describe('the areas an occupied inspection offers', () => {
  it('offers the rooms', () => {
    render(<NewInspectionPage />);

    expect(offered('Kitchen')).toBeInTheDocument();
    expect(offered('Main Bedroom')).toBeInTheDocument();
  });

  /**
   * The reported complaint. These are the AC Filter Change screen's subject,
   * not rooms to walk, and the office was looking at them on an occupied form.
   */
  it('does not offer an HVAC visit’s subjects as rooms to walk', () => {
    render(<NewInspectionPage />);

    for (const name of ['AC filters', 'Filters', 'A/C unit', 'Thermostat', 'Attic'])
      expect(offered(name)).not.toBeInTheDocument();
  });

  /** A technician's own find is a room, and dropping it would lose real work. */
  it('keeps an area a technician added on site', () => {
    render(<NewInspectionPage />);

    expect(offered('Bathroom 2')).toBeInTheDocument();
  });

  it('never offers one nobody has approved', () => {
    render(<NewInspectionPage />);

    expect(offered('Shed')).not.toBeInTheDocument();
  });

  /**
   * The count under the list is what the office reads to check the scope, and
   * it counted the areas that were about to be refused.
   */
  it('counts only what it offers', () => {
    render(<NewInspectionPage />);

    expect(screen.getByText('3 of 3 areas')).toBeInTheDocument();
  });
});

/**
 * A property with no approved areas shows the area-setup alert, and the
 * failure of either way past it -- the create itself, or "Inspect it as one
 * single area" -- was the `else` of that alert, so it was never shown on the
 * one property it could happen on.
 */
describe('a failure on a property with no approved areas', () => {
  beforeEach(() => {
    address.search = 'type=OCCUPIED&propertyId=property-1';
    queries.usePropertyAreas.mockReturnValue(
      list(AREAS.filter((area) => area.status !== 'APPROVED')),
    );
  });

  it('shows the area-setup alert and the failed create together', () => {
    queries.useAdminMutations.mockReturnValue({
      createInspection: {
        mutateAsync: vi.fn(),
        isPending: false,
        error: new Error('The inspection could not be created.'),
      },
      createFallbackPropertyArea: { mutateAsync: vi.fn(), isPending: false },
    });
    render(<NewInspectionPage />);

    expect(screen.getByText('This property has no approved inspection areas')).toBeInTheDocument();
    expect(screen.getByText('The inspection could not be created.')).toBeInTheDocument();
  });

  it('shows a failed "Inspect it as one single area"', () => {
    queries.useAdminMutations.mockReturnValue({
      createInspection: { mutateAsync: vi.fn(), isPending: false },
      createFallbackPropertyArea: {
        mutateAsync: vi.fn(),
        isPending: false,
        error: new Error('The single area could not be prepared.'),
      },
    });
    render(<NewInspectionPage />);

    expect(screen.getByText('This property has no approved inspection areas')).toBeInTheDocument();
    expect(screen.getByText('The single area could not be prepared.')).toBeInTheDocument();
  });
});
