import { describe, expect, it } from 'vitest';

import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  isPermissionKey,
  resolveEffectivePermissions,
} from '../src/rbac/permissions.js';

const catalogued = PERMISSION_CATALOG.flatMap((group) =>
  group.permissions.map((permission) => permission.key),
);

describe('permission catalog', () => {
  /**
   * The failure this guards against is silent and total: a key added to
   * `PERMISSION_KEYS` and enforced by `@RequirePermissions` but never added to
   * the catalog cannot be selected in the role editor, because the editor is
   * built from the catalog. The route is then unreachable by every account
   * except the bootstrap SYSTEM_ADMIN, and nothing anywhere reports why.
   */
  it('offers every enforceable key in the role editor', () => {
    const missing = PERMISSION_KEYS.filter((key) => !catalogued.includes(key));
    expect(missing).toEqual([]);
  });

  it('has no catalog entry for a key that cannot be enforced', () => {
    const unknown = catalogued.filter((key) => !isPermissionKey(key));
    expect(unknown).toEqual([]);
  });

  it('lists each key exactly once, so a role cannot show a duplicate checkbox', () => {
    expect(new Set(catalogued).size).toBe(catalogued.length);
  });

  /**
   * Deletion is its own key on purpose. Folding it into `inspections:manage`
   * would mean every account that can edit or cancel an inspection could also
   * erase one, and cancelling is the reversible way to close one.
   */
  it('keeps inspection deletion separate from inspection management', () => {
    expect(isPermissionKey('inspections:delete')).toBe(true);
    expect(catalogued).toContain('inspections:delete');
    expect('inspections:delete').not.toBe('inspections:manage');
  });
});

describe('SYSTEM_ADMIN inheritance', () => {
  /**
   * The break-glass account must hold every capability the moment one is added,
   * with nobody granting it anything.
   *
   * `resolveEffectivePermissions` does this by returning the whole
   * `PERMISSION_KEYS` array for SYSTEM_ADMIN, so inheritance is automatic today.
   * What this test defends is that *property*: the obvious future edit is to
   * replace the spread with an explicit list — for auditability, or to withhold
   * one dangerous key — and the moment anyone does, every key added afterwards
   * silently stops reaching the super admin. That failure is invisible until
   * somebody signs in as the bootstrap account and finds a menu missing.
   */
  it('grants the super admin every key in the catalog, including new ones', () => {
    const effective = resolveEffectivePermissions(['SYSTEM_ADMIN'], []);
    expect([...effective].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it('grants it with no custom roles assigned at all', () => {
    // The bootstrap principal exists precisely for the state where no custom
    // role has been created yet, so an empty second argument must still work.
    expect(resolveEffectivePermissions(['SYSTEM_ADMIN'], [])).toContain('inspections:delete');
  });

  it('does not leak the catalog to any other legacy role', () => {
    // The inverse invariant. Membership labels never imply permissions —
    // everything else comes from administrator-created roles only.
    for (const role of ['PROPERTY_ADMIN', 'INSPECTION_TECHNICIAN', 'CONDITION_REVIEWER'])
      expect(resolveEffectivePermissions([role], [])).toEqual([]);
  });

  it('ignores an unknown key sitting in a custom role', () => {
    expect(resolveEffectivePermissions([], ['inspections:read', 'not:a:real:key'])).toEqual([
      'inspections:read',
    ]);
  });
});
