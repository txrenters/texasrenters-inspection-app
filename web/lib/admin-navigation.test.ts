import { describe, expect, it } from 'vitest';

import { InspectionType } from '@texasrenters/shared';

import {
  activeNavigationChild,
  adminNavigation,
  getAdminBreadcrumbs,
  getVisibleAdminNavigation,
  isAdminNavigationItemActive,
  navigationChildHref,
} from './admin-navigation';

const inspections = adminNavigation
  .flatMap((group) => group.items)
  .find((item) => item.href === '/inspections')!;

describe('admin navigation', () => {
  it('matches exact routes and their descendants without substring collisions', () => {
    expect(isAdminNavigationItemActive('/inspections', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspections/inspection-1', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspections?status=ACTIVE', '/inspections')).toBe(true);
    expect(isAdminNavigationItemActive('/inspection-templates', '/inspections')).toBe(false);
    expect(isAdminNavigationItemActive('/properties-archive', '/properties')).toBe(false);
  });

  describe('IT tools', () => {
    it('is gated on system:manage, like the other operator controls', () => {
      const withoutSystem = getVisibleAdminNavigation((permission) =>
        ['dashboard:read', 'roles:read'].includes(permission),
      );
      expect(withoutSystem.map((group) => group.title)).not.toContain('IT tools');

      const withSystem = getVisibleAdminNavigation((permission) => permission === 'system:manage');
      expect(withSystem.map((group) => group.title)).toEqual(['IT tools']);
      // The error log sits here rather than under a support heading of its own:
      // it is read by whoever is already holding the API and client registry,
      // and it is gated on the same operator permission.
      expect(withSystem[0]!.items.map((item) => item.title)).toEqual([
        'API',
        'API clients',
        'Error log',
      ]);
    });

    it('does not let the reference route swallow the client registry', () => {
      // `/it-tools/api` is a prefix of `/it-tools/api-clients` as a string but
      // not as a path, and the active-state check has to know the difference —
      // otherwise opening the registry highlights both entries at once.
      expect(isAdminNavigationItemActive('/it-tools/api-clients', '/it-tools/api')).toBe(false);
      expect(isAdminNavigationItemActive('/it-tools/api', '/it-tools/api')).toBe(true);
    });

    it('names both pages in the breadcrumb rather than calling them a detail view', () => {
      expect(getAdminBreadcrumbs('/it-tools/api')).toEqual([{ title: 'API' }]);
      expect(getAdminBreadcrumbs('/it-tools/api-clients')).toEqual([{ title: 'API clients' }]);
    });
  });

  it('removes unauthorized items and empty groups without changing route ownership', () => {
    const visible = getVisibleAdminNavigation((permission) =>
      ['dashboard:read', 'properties:read'].includes(permission),
    );
    const titles = visible.flatMap((group) => group.items.map((item) => item.title));

    // Settings and Profile live in the account dropdown, not the nav tree.
    //
    // Tenants sits on `properties:read` deliberately: a tenancy is a fact about
    // a property, and anyone who may see the property may see who is in it.
    // Giving it a permission of its own would mean every existing
    // property-reader silently losing a page they should have.
    expect(titles).toEqual(['Dashboard', 'Properties', 'Tenants']);
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

  describe('inspection type sub-items', () => {
    it('offers the whole list, then the types the office inspects, in every section', () => {
      // Roof, Supra + lockbox placement and removal, and AC filter delivery are
      // not sections of their own (the office, 2026-09-17). The whole list is
      // where they are, which is why it comes first.
      //
      // Over every section rather than only Inspections: Assignments carries
      // the same list, and asserting one of them is how the two drift.
      const sectioned = adminNavigation
        .flatMap((group) => group.items)
        .filter((item) => item.children?.length);
      expect(sectioned.map((item) => item.title)).toEqual(['Inspections', 'Assignments']);

      for (const item of sectioned) {
        expect(item.children).toEqual([
          { title: `All ${item.title.toLowerCase()}`, type: '' },
          { title: 'Move-in', type: 'MOVE_IN' },
          { title: 'Occupied', type: 'OCCUPIED' },
          { title: 'Back-to-market', type: 'BACK_TO_MARKET' },
          { title: 'Move-out', type: 'MOVE_OUT' },
          { title: 'HVAC', type: 'HVAC' },
        ]);
        // Each one a real type: a misspelt one is a section of nothing.
        for (const child of item.children!.filter((entry) => entry.type))
          expect(Object.values(InspectionType)).toContain(child.type);
      }
    });

    it.each([
      ['/inspections', 'All inspections'],
      ['/assignments', 'All assignments'],
    ])('sends the whole-list sub-item of %s to the plain list, not to an empty filter', (href, title) => {
      // `?type=` is not "no filter" — the page would forward the blank to an
      // API that rejects anything outside the enum.
      const item = adminNavigation.flatMap((group) => group.items).find((entry) => entry.href === href)!;
      expect(navigationChildHref(item, { title, type: '' })).toBe(href);
      expect(activeNavigationChild(item, href, null)?.title).toBe(title);
    });

    it('links to the list carrying the type, not to a nested route', () => {
      // `/inspections/move-out` would be captured by `[inspectionId]` and
      // fetched as an inspection id.
      expect(navigationChildHref(inspections, { title: 'Move-out', type: 'MOVE_OUT' })).toBe(
        '/inspections?type=MOVE_OUT',
      );
    });

    it('marks a sub-item active only on the list itself', () => {
      expect(activeNavigationChild(inspections, '/inspections', 'MOVE_OUT')?.title).toBe(
        'Move-out',
      );

      // No type selected is the whole list, which is a sub-item of its own.
      expect(activeNavigationChild(inspections, '/inspections', null)?.title).toBe('All inspections');
      // A detail page belongs to no single type filter, even though the parent
      // stays highlighted for it.
      expect(activeNavigationChild(inspections, '/inspections/inspection-1', 'MOVE_OUT')).toBe(
        undefined,
      );
      // A type the nav does not offer must not highlight anything: neither a
      // made-up one, nor one that is a type but no longer a section.
      expect(activeNavigationChild(inspections, '/inspections', 'NOT_A_TYPE')).toBeUndefined();
      expect(activeNavigationChild(inspections, '/inspections', 'ROOF')).toBeUndefined();
    });

    it('shows the open type as a breadcrumb under Inspections', () => {
      expect(getAdminBreadcrumbs('/inspections', 'MOVE_OUT')).toEqual([
        { title: 'Inspections', href: '/inspections' },
        { title: 'Move-out' },
      ]);

      expect(getAdminBreadcrumbs('/inspections', null)).toEqual([
        { title: 'Inspections', href: '/inspections' },
        { title: 'All inspections' },
      ]);
      // An unknown type is not a section, so the trail stays as it was.
      expect(getAdminBreadcrumbs('/inspections', 'NOT_A_TYPE')).toEqual([{ title: 'Inspections' }]);
      // The type does not leak onto a detail page's trail.
      expect(getAdminBreadcrumbs('/inspections/inspection-1', 'MOVE_OUT')).toEqual([
        { title: 'Inspections', href: '/inspections' },
        { title: 'Inspection detail' },
      ]);
    });
  });
});
