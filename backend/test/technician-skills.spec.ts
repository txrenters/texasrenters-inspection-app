import { InspectionType, SkillRequirementLevel } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import { TechnicianSkillsService, qualifyOn } from '../src/admin/technician-skills.service';

const VISIT_DAY = new Date('2026-11-20T00:00:00.000Z');

const TECHNICIANS = [
  { id: 'tech-ana', displayName: 'Ana' },
  { id: 'tech-ben', displayName: 'Ben' },
];

const inputs = (
  required: string[],
  preferred: string[],
  grants: { technicianId: string; skillId: string; expiresAt?: Date | null }[],
) => ({
  required,
  preferred,
  technicians: TECHNICIANS,
  grants: grants.map((grant) => ({ ...grant, expiresAt: grant.expiresAt ?? null })),
});

const idsOf = (qualified: ReturnType<typeof qualifyOn>) =>
  qualified.map((candidate) => candidate.technicianId);

describe('who is qualified for a kind of inspection', () => {
  /**
   * The load-bearing default. Requirements start empty in every organization,
   * so if an empty matrix disqualified everyone, deploying this feature would
   * make every inspection unassignable — and the console would report it as
   * "no qualified technicians", which reads like a staffing problem rather
   * than an unconfigured one.
   */
  it('qualifies every active technician when nothing is required', () => {
    expect(idsOf(qualifyOn(inputs([], [], []), VISIT_DAY))).toEqual(['tech-ana', 'tech-ben']);
  });

  it('drops a technician who does not hold a required skill', () => {
    const qualified = qualifyOn(
      inputs(['skill-hvac'], [], [{ technicianId: 'tech-ana', skillId: 'skill-hvac' }]),
      VISIT_DAY,
    );

    expect(idsOf(qualified)).toEqual(['tech-ana']);
  });

  it('requires every required skill, not merely one of them', () => {
    const qualified = qualifyOn(
      inputs(
        ['skill-hvac', 'skill-lead'],
        [],
        [
          { technicianId: 'tech-ana', skillId: 'skill-hvac' },
          { technicianId: 'tech-ana', skillId: 'skill-lead' },
          { technicianId: 'tech-ben', skillId: 'skill-hvac' },
        ],
      ),
      VISIT_DAY,
    );

    expect(idsOf(qualified)).toEqual(['tech-ana']);
  });

  /**
   * PREFERRED ranks, it does not filter. Without that distinction every
   * eligible technician ties and the assignment falls back to whatever order
   * the database returned — which is not "most qualified", it is alphabetical.
   */
  it('ranks on preferred skills without excluding anyone for missing them', () => {
    const qualified = qualifyOn(
      inputs([], ['skill-pool'], [{ technicianId: 'tech-ben', skillId: 'skill-pool' }]),
      VISIT_DAY,
    );

    expect(qualified).toEqual([
      { technicianId: 'tech-ana', displayName: 'Ana', preferredHeld: 0, preferredTotal: 1 },
      { technicianId: 'tech-ben', displayName: 'Ben', preferredHeld: 1, preferredTotal: 1 },
    ]);
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
  const lapsing = inputs(
    ['skill-hvac'],
    [],
    [
      { technicianId: 'tech-ana', skillId: 'skill-hvac', expiresAt: new Date('2026-11-20') },
      { technicianId: 'tech-ben', skillId: 'skill-hvac', expiresAt: null },
    ],
  );

  it('still qualifies somebody on the last day their skill is valid', () => {
    expect(idsOf(qualifyOn(lapsing, new Date('2026-11-20T00:00:00.000Z')))).toEqual([
      'tech-ana',
      'tech-ben',
    ]);
  });

  it('disqualifies them the day after, while the plan is still being built', () => {
    expect(idsOf(qualifyOn(lapsing, new Date('2026-11-21T00:00:00.000Z')))).toEqual(['tech-ben']);
  });

  it('still qualifies them earlier in the quarter', () => {
    expect(idsOf(qualifyOn(lapsing, new Date('2026-10-01T00:00:00.000Z')))).toEqual([
      'tech-ana',
      'tech-ben',
    ]);
  });

  /**
   * Compared as calendar days, not instants. `expiresAt` is a DATE column and
   * Prisma hands it back as midnight UTC, so comparing `Date` objects directly
   * would make a visit at any hour of the expiry day look later than it.
   */
  it('treats the expiry as a whole day rather than an instant', () => {
    expect(idsOf(qualifyOn(lapsing, new Date('2026-11-20T23:59:59.000Z')))).toContain('tech-ana');
  });
});

describe('asking the same question across a quarter', () => {
  const prismaWith = (
    requirements: { skillId: string; requirement: SkillRequirementLevel }[],
    grants: { technicianId: string; skillId: string; expiresAt: Date | null }[],
  ) => {
    const grantFindMany = jest.fn().mockResolvedValue(grants);
    return {
      service: new TechnicianSkillsService({
        inspectionTypeSkillRequirement: { findMany: jest.fn().mockResolvedValue(requirements) },
        userProfile: { findMany: jest.fn().mockResolvedValue(TECHNICIANS) },
        technicianSkillGrant: { findMany: grantFindMany },
      } as unknown as PrismaService),
      grantFindMany,
    };
  };

  /**
   * One set of queries for the whole quarter, not one per day. Sixty-two round
   * trips to learn something that changes only when a certificate lapses is a
   * cost with nothing to show for it.
   */
  it('reads the grants once for every day it answers', async () => {
    const { service, grantFindMany } = prismaWith(
      [{ skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED }],
      [
        { technicianId: 'tech-ana', skillId: 'skill-hvac', expiresAt: new Date('2026-11-20') },
        { technicianId: 'tech-ben', skillId: 'skill-hvac', expiresAt: null },
      ],
    );

    const calendar = await service.qualificationCalendar(
      'org-1',
      InspectionType.OCCUPIED,
      [
        new Date('2026-10-01T00:00:00.000Z'),
        new Date('2026-11-20T00:00:00.000Z'),
        new Date('2026-11-21T00:00:00.000Z'),
      ],
    );

    expect(grantFindMany).toHaveBeenCalledTimes(1);
    expect(idsOf(calendar.get('2026-10-01')!)).toEqual(['tech-ana', 'tech-ben']);
    expect(idsOf(calendar.get('2026-11-20')!)).toEqual(['tech-ana', 'tech-ben']);
    // The certificate lapses mid-quarter, and only the later days lose it.
    expect(idsOf(calendar.get('2026-11-21')!)).toEqual(['tech-ben']);
  });

  /**
   * Revocation is filtered in the query rather than in `qualifyOn`, because a
   * revoked grant is never relevant on any date — unlike expiry, which is.
   * Asserted on the query itself, since that is where the rule now lives: drop
   * the clause and every revoked skill silently counts again.
   */
  it('never reads a revoked grant', async () => {
    const { service, grantFindMany } = prismaWith(
      [{ skillId: 'skill-hvac', requirement: SkillRequirementLevel.REQUIRED }],
      [],
    );

    await service.qualifiedTechnicians('org-1', InspectionType.OCCUPIED, VISIT_DAY);

    const where = grantFindMany.mock.calls[0][0].where as { revokedAt: null };
    expect(where.revokedAt).toBeNull();
  });

  it('does not go looking for grants when nothing is required', async () => {
    const { service, grantFindMany } = prismaWith([], []);

    const qualified = await service.qualifiedTechnicians(
      'org-1',
      InspectionType.OCCUPIED,
      VISIT_DAY,
    );

    expect(idsOf(qualified)).toEqual(['tech-ana', 'tech-ben']);
    expect(grantFindMany).not.toHaveBeenCalled();
  });
});
