import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  MACHINE_GRANTABLE_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
} from '@texasrenters/shared';

const CONTROLLER = readFileSync(
  join(__dirname, '..', 'src', 'admin', 'admin.controller.ts'),
  'utf8',
);
const SEEDS = readFileSync(join(__dirname, '..', 'prisma', 'seed-roles.ts'), 'utf8');

/**
 * Deleting a property area is irreversible and reaches the layout every future
 * inspection is copied from. It rode on `properties:manage`, which every
 * property administrator holds — so the only way to stop somebody erasing a
 * layout was to stop them editing properties at all.
 */
describe('deleting a property area is its own permission', () => {
  it('exists in the catalog, so a role can be given or denied it', () => {
    expect(PERMISSION_KEYS).toContain('properties:delete-areas');
    const entry = PERMISSION_CATALOG.flatMap((group) => group.permissions).find(
      (permission) => permission.key === 'properties:delete-areas',
    );
    expect(entry?.label).toBeTruthy();
    // The description is what an administrator reads before granting it, so it
    // has to say the part that cannot be undone.
    expect(entry?.description).toMatch(/permanently|irreversible/i);
  });

  it('gates both the single and the bulk delete', () => {
    // The bulk route is the dangerous one: it is how twenty areas go at once.
    const single = CONTROLLER.slice(CONTROLLER.indexOf("@Delete('property-areas/:areaId')"));
    expect(single).toMatch(/^[\s\S]{0,200}RequirePermissions\('properties:delete-areas'\)/);
    const bulk = CONTROLLER.slice(CONTROLLER.indexOf("@Post('properties/:propertyId/areas/delete')"));
    expect(bulk).toMatch(/^[\s\S]{0,200}RequirePermissions\('properties:delete-areas'\)/);
  });

  it('leaves archive on properties:manage', () => {
    // Archiving hides an area without destroying it. Putting it behind the
    // delete permission would push people toward the irreversible option.
    const archive = CONTROLLER.slice(CONTROLLER.indexOf("@Post('property-areas/:areaId/archive')"));
    expect(archive).toMatch(/^[\s\S]{0,200}RequirePermissions\('properties:manage'\)/);
  });

  it('is granted to no seeded role', () => {
    // Same stance as `inspections:delete`: an administrator hands it out
    // deliberately, rather than discovering they always had it.
    expect(SEEDS).not.toContain('properties:delete-areas');
  });

  it('is denied to machine callers', () => {
    // A credential looping over a list is exactly how irreversible becomes
    // catastrophic rather than merely bad.
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('properties:delete-areas');
    // And therefore absent from what an API client can actually be granted.
    expect(MACHINE_GRANTABLE_PERMISSIONS).not.toContain('properties:delete-areas');
  });
});
