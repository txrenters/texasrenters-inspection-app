import { AdminService } from '../src/admin/admin.service';
import type { PropertyListQueryDto } from '../src/admin/admin.dto';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Occupied and vacant are a different question from active.
 *
 * `isActive` says TexasRenters still manages the property; occupancy says
 * whether a tenant is in residence, and Propertyware keeps them in two
 * separate fields. 132 of the 574 active properties are `Vacant`, and every
 * one of them is still managed and still inspectable — a move-out inspection
 * happens *because* a property became vacant.
 *
 * Conflating them would be a quiet, expensive error: filtering the list by
 * `isActive` to mean "occupied" would hide 132 real properties, and the page
 * would look correct while doing it.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const query = (overrides: Partial<PropertyListQueryDto> = {}) =>
  ({ page: 1, pageSize: 20, ...overrides }) as PropertyListQueryDto;

function build() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    propertywareBuilding: { findMany, count: jest.fn().mockResolvedValue(0) },
  };
  // Everything after `presence` is optional, and constructing without a cache
  // is what makes `cacheRead` fall through to the loader this asserts on.
  const service = new AdminService(prisma as never, {} as never);
  return { service, findMany };
}

const whereOf = (findMany: jest.Mock) => findMany.mock.calls[0][0].where;

describe('filtering properties by occupancy', () => {
  it('reads Propertyware’s own word, not the active flag', async () => {
    const { service, findMany } = build();
    await service.properties(user, query({ occupancy: 'OCCUPIED' }));

    const where = whereOf(findMany);
    expect(where.sourceStatus).toEqual({ equals: 'OCCUPIED', mode: 'insensitive' });
    // And the two stay independent: an occupancy filter never narrows to, or
    // widens beyond, properties under management.
    expect(where.isActive).toBe(true);
  });

  it('matches whatever casing the other system wrote', async () => {
    // `sourceStatus` is free text from Propertyware, not an enum we control.
    // An exact-casing equality is the kind of filter that returns nothing at
    // all the day somebody writes "occupied", and reads as "no vacancies".
    const { service, findMany } = build();
    await service.properties(user, query({ occupancy: 'VACANT' }));
    expect(whereOf(findMany).sourceStatus.mode).toBe('insensitive');
  });

  it('does not filter on occupancy when no tab is chosen', async () => {
    // The All tab must show vacant properties too — they are managed and
    // inspectable, and a list that quietly omitted them would be wrong in the
    // direction nobody checks.
    const { service, findMany } = build();
    await service.properties(user, query());
    expect(whereOf(findMany).sourceStatus).toBeUndefined();
  });

  it('still limits every tab to this organization', async () => {
    const { service, findMany } = build();
    await service.properties(user, query({ occupancy: 'VACANT' }));
    expect(whereOf(findMany).organizationId).toBe(user.organizationId);
  });

  it('composes with the other filters rather than replacing them', async () => {
    // The tab counts carry the search and portfolio in force, so occupancy has
    // to sit alongside them — a count that ignored the search would answer a
    // question nobody asked.
    const { service, findMany } = build();
    await service.properties(
      user,
      query({ occupancy: 'OCCUPIED', portfolioId: '00000000-0000-4000-8000-000000000003' }),
    );

    const where = whereOf(findMany);
    expect(where.sourceStatus).toEqual({ equals: 'OCCUPIED', mode: 'insensitive' });
    expect(where.portfolioId).toBe('00000000-0000-4000-8000-000000000003');
  });
});
