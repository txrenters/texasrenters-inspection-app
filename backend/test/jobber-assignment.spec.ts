import {
  resolveAssignment,
  unknownAssigneeReason,
  visitAssignees,
} from '../src/integrations/jobber/jobber.assignment';
import type { PrismaService } from '../src/common/prisma.service';
import type { JobberVisit } from '../src/integrations/jobber/jobber.schemas';

const visit = (
  assignees: Array<{ email?: string | null; name?: string | null }> | null,
): JobberVisit =>
  ({
    id: 'visit-1',
    assignedUsers: assignees
      ? {
          nodes: assignees.map((a, index) => ({
            id: `user-${index}`,
            email: a.email === undefined ? null : { raw: a.email },
            name: { full: a.name ?? null },
          })),
        }
      : null,
  }) as unknown as JobberVisit;

const prismaWith = (technicians: Array<{ id: string; email: string }>) =>
  ({
    userProfile: { findMany: jest.fn().mockResolvedValue(technicians) },
  }) as unknown as PrismaService;

describe('matching a Jobber assignee to a technician', () => {
  it('matches on email regardless of how the name is spelled', async () => {
    // Jobber holds "kevin granados"; this app holds "Kevin Granados". Real
    // data, and the reason this matches on email rather than name.
    const prisma = prismaWith([{ id: 'tech-kevin', email: 'Kevin.G@txhomemp.com' }]);
    const resolution = await resolveAssignment(
      prisma,
      'org-1',
      visit([{ email: 'kevin.g@txhomemp.com', name: 'kevin granados' }]),
    );
    expect(resolution).toEqual({
      outcome: 'MATCHED',
      match: { technicianId: 'tech-kevin', email: 'kevin.g@txhomemp.com' },
    });
  });

  it('leaves an unrecognised assignee unassigned rather than approximating', async () => {
    // About half the assignees on the live calendar are Jobber users this app
    // does not know. Putting the wrong technician on an inspection sends the
    // wrong person to somebody's home.
    const resolution = await resolveAssignment(
      prismaWith([]),
      'org-1',
      visit([{ email: 'mvr@txhomemp.com', name: 'Moses Rodriguez' }]),
    );
    expect(resolution.outcome).toBe('UNKNOWN_ASSIGNEE');
  });

  it('names who Jobber assigned, so the console can explain itself', () => {
    expect(
      unknownAssigneeReason([{ email: 'mvr@txhomemp.com', name: 'Moses Rodriguez' }]),
    ).toContain('Moses Rodriguez');
  });

  it('takes the first assignee it recognises when a visit has several', async () => {
    const prisma = prismaWith([{ id: 'tech-amy', email: 'amy.w@txhomemp.com' }]);
    const resolution = await resolveAssignment(
      prisma,
      'org-1',
      visit([
        { email: 'b.iniguez@txhomemp.com', name: 'Beatriz Iniguez' },
        { email: 'amy.w@txhomemp.com', name: 'Amy Wilson' },
      ]),
    );
    expect(resolution).toMatchObject({ outcome: 'MATCHED', match: { technicianId: 'tech-amy' } });
  });

  it('reports no assignee separately from an unrecognised one', async () => {
    // Different situations: nobody is on the visit yet, versus somebody is and
    // we cannot place them. Only the second needs a person to look.
    expect((await resolveAssignment(prismaWith([]), 'org-1', visit([]))).outcome).toBe(
      'NO_ASSIGNEE',
    );
    expect((await resolveAssignment(prismaWith([]), 'org-1', visit(null))).outcome).toBe(
      'NO_ASSIGNEE',
    );
  });

  it('does not treat an assignee with no email as a match candidate', async () => {
    // One real Jobber user is `none@noemail.com`; others may have none at all.
    const resolution = await resolveAssignment(
      prismaWith([{ id: 'tech-amy', email: 'amy.w@txhomemp.com' }]),
      'org-1',
      visit([{ email: null, name: 'Sylvia Cerda' }]),
    );
    expect(resolution.outcome).toBe('UNKNOWN_ASSIGNEE');
  });

  it('only considers active technicians of this organization', async () => {
    const prisma = prismaWith([]);
    await resolveAssignment(prisma, 'org-1', visit([{ email: 'amy.w@txhomemp.com' }]));
    // An administrator with a matching email is not a technician, and assigning
    // to them would put the inspection in a queue nobody looks at.
    const where = jest.mocked(prisma.userProfile.findMany).mock.calls[0][0]?.where as Record<
      string,
      unknown
    >;
    expect(where.isActive).toBe(true);
    expect(JSON.stringify(where.memberships)).toContain('INSPECTION_TECHNICIAN');
    expect(JSON.stringify(where.memberships)).toContain('org-1');
  });
});

describe('reading assignees off a visit', () => {
  it('lowercases emails so casing cannot cause a miss', () => {
    expect(visitAssignees(visit([{ email: '  Amy.W@TXHOMEMP.com ' }]))[0].email).toBe(
      'amy.w@txhomemp.com',
    );
  });
});
