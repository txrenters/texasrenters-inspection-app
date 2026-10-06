import { UserRole } from '@texasrenters/shared';

import { AdminService } from '../src/admin/admin.service';
import { inspectionSearchWhere, inspectionStatusWhere } from '../src/admin/inspection-list-where';
import type { AuthenticatedUser } from '../src/common/auth';
import { searchTerms } from '../src/common/search-terms';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * The inspections list's search, day and status (the office, 2026-10-07: "if I
 * search for a property or a schedule or the technician it will not show
 * sometimes").
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000002',
  authUserId: 'auth-admin',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Office',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['inspections:read'],
  mustChangePassword: false,
  principalType: 'USER',
};

function listing() {
  const prisma = {
    inspection: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    inspectionPhoto: { groupBy: jest.fn().mockResolvedValue([]) },
    propertywareTenant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new AdminService(prisma as never, new PresenceService());
  const list = async (query: Record<string, unknown>) => {
    await service.inspections(user, { page: 1, pageSize: 20, ...query } as never);
    return prisma.inspection.findMany.mock.calls.at(-1)![0] as {
      where: { AND?: unknown[] } & Record<string, unknown>;
      select: Record<string, unknown>;
    };
  };
  return { list, prisma };
}

describe('what was typed, as words', () => {
  it('finds every word, in any order, whatever the punctuation', () => {
    expect(searchTerms('  Flower Gate, 5819  ')).toEqual([['flower'], ['gate'], ['5819']]);
  });

  it('finds a street word in either spelling', () => {
    expect(searchTerms('Rolling Stream Dr')).toEqual([['rolling'], ['stream'], ['drive', 'dr']]);
    expect(searchTerms('Lane')).toEqual([['lane', 'ln']]);
  });

  it('leaves out the words nobody’s data holds, and repeats', () => {
    expect(searchTerms('Unit B apt b')).toEqual([['b']]);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms(undefined)).toEqual([]);
  });
});

describe('the search', () => {
  it('looks for each word in the property, the unit, the visit title and the technician', () => {
    const [clause] = inspectionSearchWhere('Amy');
    const text = JSON.stringify(clause);

    expect(text).toContain('"assignments":{"some":{"isCurrent":true,"technician":{"displayName":{"contains":"amy"');
    expect(text).toContain('"jobberVisitTitle":{"contains":"amy"');
    expect(text).toContain('"propertywareUnit":{"name":{"contains":"amy"');
    expect(text).toContain('"city":{"contains":"amy"');
    // A property the inspection was created against, without Propertyware.
    expect(text).toContain('"property":{"name":{"contains":"amy"');
  });

  it('needs every word found, one clause each, and either spelling of a street word', () => {
    const clauses = inspectionSearchWhere('Rolling Stream Dr');

    expect(clauses).toHaveLength(3);
    expect(JSON.stringify(clauses[2])).toContain('"contains":"drive"');
    expect(JSON.stringify(clauses[2])).toContain('"contains":"dr"');
  });

  it('reaches the technician from the list, and never overwrites another filter', async () => {
    const { list } = listing();

    const query = await list({ search: 'Amy Wilson', status: 'DONE', unassignedOnly: 'false' });

    // Two words, and the status's own OR, all side by side.
    expect(query.where.AND).toHaveLength(3);
    expect(JSON.stringify(query.where.AND)).toContain('"displayName":{"contains":"wilson"');
    expect(query.where.OR).toBeUndefined();
  });
});

describe('unassigned', () => {
  it('is a visit still to come with nobody on it, as the dashboard counts it', async () => {
    const { list } = listing();

    const query = await list({ unassignedOnly: 'true' });
    const upcoming = (query.where.AND as Array<{ status?: { in: string[] } }>).find((clause) => clause.status)!;

    expect(query.where.AND).toContainEqual({ assignments: { none: { isCurrent: true } } });
    expect(upcoming.status!.in).toEqual(
      expect.arrayContaining(['SCHEDULED', 'IN_PROGRESS', 'FOLLOW_UP_REQUIRED']),
    );
    for (const finished of ['CANCELLED', 'COMPLETED', 'TECHNICIAN_SUBMITTED', 'REVIEW_REQUIRED'])
      expect(upcoming.status!.in).not.toContain(finished);
  });
});

describe('one day', () => {
  it('is the visits scheduled on it, held as that day’s UTC midnight', async () => {
    const { list } = listing();

    const query = await list({ scheduledOn: '2026-12-14' });

    expect(query.where.AND).toContainEqual({ scheduledAt: new Date('2026-12-14T00:00:00.000Z') });
  });
});

describe('the status filter, in the office’s words', () => {
  it('reads Done as every submitted visit the technician got into', () => {
    const done = inspectionStatusWhere('DONE') as { status: { in: string[] }; OR: unknown[] };

    expect(done.status.in).toEqual(
      expect.arrayContaining(['TECHNICIAN_SUBMITTED', 'PROCESSING', 'REVIEW_REQUIRED', 'COMPLETED']),
    );
    expect(done.status.in).not.toContain('CANCELLED');
    // A null reason is done too: NOT startsWith alone would drop it in SQL.
    expect(done.OR).toContainEqual({ completionBlockedReason: null });
  });

  it('reads Could not get in from the technician’s reason', () => {
    expect(inspectionStatusWhere('COULD_NOT_GET_IN')).toMatchObject({
      completionBlockedReason: { startsWith: 'Could not get in' },
    });
  });

  it('still honours a raw status from a link written before', () => {
    expect(inspectionStatusWhere('REVIEW_REQUIRED')).toEqual({ status: 'REVIEW_REQUIRED' });
    expect(inspectionStatusWhere('FOLLOW_UP')).toEqual({ status: 'FOLLOW_UP_REQUIRED' });
  });

  it('hands each row what it needs to say it the same way', async () => {
    const { list } = listing();

    const query = await list({});

    expect(query.select.completionBlockedReason).toBe(true);
  });
});
