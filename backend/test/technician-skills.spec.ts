import { InspectionType, SkillRequirementLevel } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import { TechnicianSkillsService } from '../src/admin/technician-skills.service';

const VISIT_DAY = new Date('2026-11-20T00:00:00.000Z');

type Requirement = { skillId: string; requirement: SkillRequirementLevel };
type Grant = { technicianId: string; skillId: string };

/**
 * The grant query filters on expiry in Postgres, so a fake that ignored the
 * `where` would pass a service that had stopped filtering at all. This applies
 * the same two rules the query does, which is what makes the expiry tests below
 * mean something.
 */
const prismaWith = (
  requirements: Requirement[],
  technicians: Array<{ id: string; displayName: string }>,
  grants: Array<Grant & { expiresAt?: Date | null; revokedAt?: Date | null }>,
) => {
  const grantFindMany = jest.fn(({ where }: { where: Record<string, unknown> }) => {
    const wanted = new Set((where.skillId as { in: string[] }).in);
    const onDate = ((where.OR as Array<{ expiresAt?: { gte?: Date } }>) ?? []).find(
      (clause) => clause.expiresAt?.gte,
    )?.expiresAt?.gte;
    return Promise.resolve(
      grants
        .filter((grant) => wanted.has(grant.skillId))
        .filter((grant) => (where.revokedAt === null ? !grant.revokedAt : true))
        .filter((grant) => !grant.expiresAt || !onDate || grant.expiresAt >= onDate)
        .map((grant) => ({ technicianId: grant.technicianId, skillId: grant.skillId })),
    );
  });

  return {
    service: new TechnicianSkillsService({
      inspectionTypeSkillRequirement: { findMany: jest.fn().mockResolvedValue(requirements) },
      userProfile: { findMany: jest.fn().mockResolvedValue(technicians) },
      technicianSkillGrant: { findMany: grantFindMany },
    } as unknown as PrismaService),
    grantFindMany,
  };
};

const TECHNICIANS = [
  { id: 'tech-ana', displayName: 'Ana' },
  { id: 'tech-ben', displayName: 'Ben' },
];

describe('who is qualified for a kind of inspection', () => {
  /**
   * The load-bearing default. Requirements start empty in every organization,
   * so if an empty matrix disqualified everyone, deploying this feature would
   * make every inspection unassignable — and the console would report it as
   * "no qualified technicians", which reads like a staffing problem rather
   * than an unconfigured one.
   */
  it('qualifies every active technician when nothing is required', async () => {
    const { service, grantFindMany } = prismaWith([], TECHNICIANS, []);
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ana', 'tech-ben']);
    // And it does not go looking for grants it has no rule to compare against.
    expect(grantFindMany).not.toHaveBeenCalled();
  });

  it('drops a technician who does not hold a required skill', async () => {
    const { service } = prismaWith(
      [{ skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED }],
      TECHNICIANS,
      [{ technicianId: 'tech-ana', skillId: 'skill-hvac' }],
    );
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ana']);
  });

  it('requires every required skill, not merely one of them', async () => {
    const { service } = prismaWith(
      [
        { skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED },
        { skillId: 'skill-lead', requirement: SkillRequirementLevel.REQUIRED },
      ],
      TECHNICIANS,
      [
        { technicianId: 'tech-ana', skillId: 'skill-hvac' },
        { technicianId: 'tech-ana', skillId: 'skill-lead' },
        { technicianId: 'tech-ben', skillId: 'skill-hvac' },
      ],
    );
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ana']);
  });

  /**
   * PREFERRED ranks, it does not filter. Without this distinction every
   * eligible technician ties and the assignment falls back to whatever order
   * the database happened to return — which is not "most qualified", it is
   * alphabetical.
   */
  it('ranks on preferred skills without excluding anyone for missing them', async () => {
    const { service } = prismaWith(
      [{ skillId: 'skill-pool', requirement: SkillRequirementLevel.PREFERRED }],
      TECHNICIANS,
      [{ technicianId: 'tech-ben', skillId: 'skill-pool' }],
    );
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(qualified).toEqual([
      { technicianId: 'tech-ana', displayName: 'Ana', preferredHeld: 0, preferredTotal: 1 },
      { technicianId: 'tech-ben', displayName: 'Ben', preferredHeld: 1, preferredTotal: 1 },
    ]);
  });

  it('ignores a revoked grant', async () => {
    const { service } = prismaWith(
      [{ skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED }],
      TECHNICIANS,
      [
        { technicianId: 'tech-ana', skillId: 'skill-hvac' },
        {
          technicianId: 'tech-ben',
          skillId: 'skill-hvac',
          revokedAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    );
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ana']);
  });
});

/**
 * The whole reason `expiresAt` is a column rather than a boolean.
 *
 * A quarterly plan is built two weeks before the quarter starts and books work
 * up to thirteen weeks out. A certificate valid today and lapsed by week seven
 * has to disqualify week seven — evaluating against now would send somebody to
 * a job they are no longer licensed for by the time they arrive at it.
 */
describe('qualification is evaluated against the day of the visit', () => {
  const lapsingGrants = [
    {
      technicianId: 'tech-ana',
      skillId: 'skill-hvac',
      expiresAt: new Date('2026-11-20T00:00:00.000Z'),
    },
    { technicianId: 'tech-ben', skillId: 'skill-hvac', expiresAt: null },
  ];
  const requirement = [{ skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED }];

  it('still qualifies somebody on the last day their skill is valid', async () => {
    const { service } = prismaWith(requirement, TECHNICIANS, lapsingGrants);
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      new Date('2026-11-20T00:00:00.000Z'),
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ana', 'tech-ben']);
  });

  it('disqualifies them the day after, while the plan is still being built', async () => {
    const { service } = prismaWith(requirement, TECHNICIANS, lapsingGrants);
    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      new Date('2026-11-21T00:00:00.000Z'),
    );

    expect(qualified.map((candidate) => candidate.technicianId)).toEqual(['tech-ben']);
  });

  it('asks the database about the visit date rather than today', async () => {
    const { service, grantFindMany } = prismaWith(requirement, TECHNICIANS, lapsingGrants);
    await service.qualifiedTechnicians('org-1', InspectionType.OCCUPIED, VISIT_DAY);

    const where = grantFindMany.mock.calls[0][0].where as {
      revokedAt: null;
      OR: Array<{ expiresAt: null | { gte: Date } }>;
    };
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gte: VISIT_DAY } }]);
  });
});
