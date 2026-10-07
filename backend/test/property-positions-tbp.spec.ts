import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { PropertyGeocodingService } from '../src/admin/property-geocoding.service';

/**
 * Every property on the console's map, coloured as the Group maker colours it.
 *
 * The office (2026-10-01): the Group maker's map is the better one, and the
 * technician map should draw every active property that way -- in its group's
 * colour where it is in one, not only the benefit-package properties the Group
 * maker shows. So each position says its zone, whether it is on the package,
 * and its group in the active template.
 */

const building = (id: string) => ({
  id,
  name: id,
  addressLine1: `${id} Street`,
  city: 'Houston',
  state: 'TX',
  postalCode: '77044',
  latitude: 29.86,
  longitude: -95.2,
  geocodePrecision: 'ROOFTOP',
  sourceSystem: 'PROPERTYWARE',
  geofence: null,
});

function build(permissions: string[]) {
  const members = jest.fn().mockResolvedValue([
    { buildingId: 'grouped', group: { position: 12, name: 'Katy North', color: '#7f77dd' } },
  ]);
  const prisma = {
    propertywareBuilding: {
      findMany: jest.fn().mockResolvedValue([building('grouped'), building('ungrouped'), building('other'), building('far'), building('opted')]),
    },
    propertywareTenant: {
      findMany: jest.fn().mockResolvedValue([
        { propertywareBuildingId: 'grouped', zone: 'Zone 2', tbpEnrollment: 'Yes' },
        { propertywareBuildingId: 'grouped', zone: '2', tbpEnrollment: 'No' },
        { propertywareBuildingId: 'ungrouped', zone: '4', tbpEnrollment: ' yes ' },
        { propertywareBuildingId: 'other', zone: 'Not Set', tbpEnrollment: 'Not Verified' },
        { propertywareBuildingId: 'far', zone: 'Zone 5', tbpEnrollment: 'Yes' },
        // Propertyware still says yes; the office has switched it out (2026-10-08).
        {
          propertywareBuildingId: 'opted',
          zone: '3',
          tbpEnrollment: 'Yes',
          building: { serviceStatus: { managementEndedAt: null, tbpOptedOutAt: new Date('2026-10-01T15:00:00Z') } },
        },
      ]),
    },
    tbpGroupTemplateMember: { findMany: members },
  } as unknown as PrismaService;
  const user = { organizationId: 'org-1', permissions } as unknown as AuthenticatedUser;
  return { positions: () => new PropertyGeocodingService(prisma).positions(user), members };
}

const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));

describe('a property on the map, for somebody who reads the planning', () => {
  it('carries its group in the active template, so it is drawn in that colour', async () => {
    const rows = byId(await build(['properties:read', 'planning:read']).positions());

    expect(rows.get('grouped')).toMatchObject({
      tbpEnrolled: true,
      tbpGroup: { position: 12, name: 'Katy North', color: '#7f77dd' },
    });
  });

  it('says a benefit-package property in no group is in none', async () => {
    const rows = byId(await build(['properties:read', 'planning:read']).positions());

    expect(rows.get('ungrouped')).toMatchObject({ tbpEnrolled: true, tbpGroup: null });
  });

  it('says a property off the package is off it', async () => {
    // "Not Verified" is not a yes: the planner leaves it out of a quarter too.
    const rows = byId(await build(['properties:read', 'planning:read']).positions());

    expect(rows.get('other')).toMatchObject({ tbpEnrolled: false, tbpGroup: null });
  });

  /** Zone 5 is not part of the benefit package (the office, 2026-10-02): drawn as any other property. */
  it('says a property in zone 5 is off the package, enrolled or not', async () => {
    const rows = byId(await build(['properties:read', 'planning:read']).positions());

    expect(rows.get('far')).toMatchObject({ zone: '5', tbpEnrolled: false });
  });

  it('says a property the office switched out of the package is off it, whatever Propertyware says', async () => {
    const rows = byId(await build(['properties:read', 'planning:read']).positions());

    expect(rows.get('opted')).toMatchObject({ zone: '3', tbpEnrolled: false });
  });

  it('reads only the active template', async () => {
    const { positions, members } = build(['properties:read', 'planning:read']);
    await positions();

    expect(members).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-1', template: { isActive: true, archivedAt: null } },
      }),
    );
  });
});

describe('the zone a property is drawn in', () => {
  it('is the one most of its tenancies are filed under, as a number', async () => {
    const rows = byId(await build(['properties:read']).positions());

    expect(rows.get('grouped')?.zone).toBe('2');
    expect(rows.get('ungrouped')?.zone).toBe('4');
  });

  it('is none where the report says "Not Set"', async () => {
    const rows = byId(await build(['properties:read']).positions());

    expect(rows.get('other')?.zone).toBeNull();
  });
});

describe('a property on the map, for somebody who may not read the planning', () => {
  it('says nothing about the package or the groups, rather than saying no', async () => {
    // Absent, not false: the map then draws it plainly instead of claiming the
    // property is off the package.
    const { positions, members } = build(['properties:read']);
    const rows = byId(await positions());

    expect(rows.get('grouped')).not.toHaveProperty('tbpEnrolled');
    expect(rows.get('grouped')).not.toHaveProperty('tbpGroup');
    expect(members).not.toHaveBeenCalled();
  });
});
