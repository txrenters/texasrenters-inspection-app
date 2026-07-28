import { describe, expect, it } from 'vitest';

import {
  getAdminBreadcrumbs,
  getVisibleAdminNavigation,
  isAdminNavigationItemActive,
} from './admin-navigation';

describe('admin navigation', () => {
  it('matches exact routes and their descendants without substring collisions', () => {
    expect(isAdminNavigationItemActive('/inspections', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspections/inspection-1', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspections?status=ACTIVE', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspection-templates', '/inspections')).toBe(false);
    expect(isAdminNavigationItemActive('/properties-archive', '/properties')).toBe(false);
  });

  it('removes unauthorized items and empty groups without changing route ownership', () => {
    const visible = getVisibleAdminNavigation((permission) =>
      ['dashboard:read', 'properties:read'].includes(permission),
    );
    const titles = visible.flatMap((group) => group.items.map((item) => item.title));

    // Settings and Profile live in the account dropdown, not the nav tree.
    expect(titles).toEqual(['Dashboard', 'Properties']);
    expect(visible.map((group) => group.title)).toEqual(['Overview', 'Property management']);
  });

  it('builds useful breadcrumbs for create, detail, and deeper workflow routes', () => {
    expect(getAdminBreadcrumbs('/inspections/new')).toEqual([
      { title: 'Inspections', href: '/inspections' },
      { title: 'Create' },
    ]);
    expect(getAdminBreadcrumbs('/properties/property-1')).toEqual([
      { title: 'Properties', href: '/properties' },
      { title: 'Property detail' },
    ]);
    expect(getAdminBreadcrumbs('/inspections/inspection-1/charge-report')).toEqual([
      { title: 'Inspections', href: '/inspections' },
      { title: 'Inspection detail', href: '/inspections/inspection-1' },
      { title: 'Charge report' },
    ]);
  });
});
