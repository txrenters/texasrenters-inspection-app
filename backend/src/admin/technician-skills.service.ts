import { Inject, Injectable } from '@nestjs/common';
import { Prisma, SkillRequirementLevel, UserRole } from '@prisma/client';
import type { InspectionType } from '@prisma/client';

import { type AuthenticatedUser, auditActor } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import type {
  GrantTechnicianSkillDto,
  SetSkillRequirementDto,
  TechnicianSkillDto,
  UpdateTechnicianSkillDto,
} from './admin.dto';

/**
 * One technician, and how well they match a kind of inspection.
 *
 * `preferredHeld` is a count rather than a boolean because it is a ranking
 * term: two technicians who both clear the required bar are separated by how
 * many of the preferred skills they carry, and without that separation "most
 * qualified" means nothing beyond "eligible".
 */
export interface QualifiedTechnician {
  technicianId: string;
  displayName: string;
  preferredHeld: number;
  preferredTotal: number;
}

/** A skill key is a slug: lowercase, digits, and single dashes between them. */
const SKILL_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface QualificationInputs {
  required: string[];
  preferred: string[];
  technicians: { id: string; displayName: string }[];
  grants: { technicianId: string; skillId: string; expiresAt: Date | null }[];
}

/**
 * Who clears the bar on one particular day.
 *
 * Pure, so the rule that matters most here can be argued with in a test: a
 * grant is good *on* its expiry date and lapses the day after, and a null
 * expiry never lapses at all.
 *
 * **No requirements qualifies everyone**, and that default is load-bearing
 * rather than convenient. Requirements start empty in every organization, so
 * the opposite would make every inspection unassignable the day this feature is
 * switched on — and the console would report it as "no qualified technicians",
 * which reads like a staffing problem rather than an unconfigured one.
 */
export function qualifyOn(inputs: QualificationInputs, onDate: Date): QualifiedTechnician[] {
  const { required, preferred, technicians, grants } = inputs;
  if (!required.length && !preferred.length)
    return technicians.map((technician) => ({
      technicianId: technician.id,
      displayName: technician.displayName,
      preferredHeld: 0,
      preferredTotal: 0,
    }));

  const day = onDate.toISOString().slice(0, 10);
  const held = new Map<string, Set<string>>();
  for (const grant of grants) {
    if (grant.expiresAt && grant.expiresAt.toISOString().slice(0, 10) < day) continue;
    const skills = held.get(grant.technicianId) ?? new Set<string>();
    skills.add(grant.skillId);
    held.set(grant.technicianId, skills);
  }

  const qualified: QualifiedTechnician[] = [];
  for (const technician of technicians) {
    const skills = held.get(technician.id) ?? new Set<string>();
    if (!required.every((skillId) => skills.has(skillId))) continue;
    qualified.push({
      technicianId: technician.id,
      displayName: technician.displayName,
      preferredHeld: preferred.filter((skillId) => skills.has(skillId)).length,
      preferredTotal: preferred.length,
    });
  }
  return qualified;
}

@Injectable()
export class TechnicianSkillsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- catalog

  async catalog(user: AuthenticatedUser, includeInactive = false) {
    return this.prisma.technicianSkill.findMany({
      where: {
        organizationId: user.organizationId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ isActive: 'desc' }, { label: 'asc' }],
      select: {
        id: true,
        key: true,
        label: true,
        description: true,
        isActive: true,
        _count: { select: { grants: true, requirements: true } },
      },
    });
  }

  async createSkill(user: AuthenticatedUser, input: TechnicianSkillDto) {
    const key = input.key.trim().toLowerCase();
    if (!SKILL_KEY.test(key))
      throw new ApplicationError(
        422,
        'INVALID_SKILL_KEY',
        'A skill key is lowercase letters, digits and single dashes, such as "hvac-certified".',
      );

    try {
      return await this.prisma.technicianSkill.create({
        data: {
          organizationId: user.organizationId,
          key,
          label: input.label.trim(),
          description: input.description?.trim() || null,
        },
        select: { id: true, key: true, label: true, description: true, isActive: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ApplicationError(409, 'SKILL_KEY_EXISTS', 'A skill with that key already exists.');
      throw error;
    }
  }

  /**
   * The key is deliberately not editable.
   *
   * Requirements and grants both point at the row by id, so a rename would not
   * break them - but the key is what a human reads in an audit row and what an
   * import would match on, and a key that means one thing in June and another
   * in September makes both unreadable. Retire the skill and add a new one.
   */
  async updateSkill(user: AuthenticatedUser, skillId: string, input: UpdateTechnicianSkillDto) {
    await this.requireSkill(user.organizationId, skillId);
    return this.prisma.technicianSkill.update({
      where: { id: skillId },
      data: {
        ...(input.label === undefined ? {} : { label: input.label.trim() }),
        ...(input.description === undefined
          ? {}
          : { description: input.description?.trim() || null }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
      select: { id: true, key: true, label: true, description: true, isActive: true },
    });
  }

  // ----------------------------------------------------------------- grants

  async technicianSkills(user: AuthenticatedUser, technicianId: string) {
    await this.requireTechnician(user.organizationId, technicianId);
    return this.prisma.technicianSkillGrant.findMany({
      where: { organizationId: user.organizationId, technicianId },
      orderBy: [{ revokedAt: 'asc' }, { grantedAt: 'desc' }],
      select: {
        id: true,
        expiresAt: true,
        grantedAt: true,
        revokedAt: true,
        note: true,
        skill: { select: { id: true, key: true, label: true, isActive: true } },
        grantedBy: { select: { id: true, displayName: true } },
      },
    });
  }

  /**
   * Give a technician a skill.
   *
   * An upsert, not a create: the unique is one row per person per skill, so
   * re-granting something previously revoked clears `revokedAt` on the row
   * already there. Stacking a second row would make "do they hold this" an
   * ordering question, and every caller would have to get that ordering right
   * or silently read the revoked one.
   */
  async grant(user: AuthenticatedUser, technicianId: string, input: GrantTechnicianSkillDto) {
    await this.requireTechnician(user.organizationId, technicianId);
    const skill = await this.requireSkill(user.organizationId, input.skillId);
    if (!skill.isActive)
      throw new ApplicationError(
        422,
        'SKILL_RETIRED',
        'That skill has been retired and cannot be granted.',
      );

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const actor = auditActor(user);

    return this.prisma.$transaction(async (tx) => {
      const grant = await tx.technicianSkillGrant.upsert({
        where: {
          organizationId_technicianId_skillId: {
            organizationId: user.organizationId,
            technicianId,
            skillId: skill.id,
          },
        },
        create: {
          organizationId: user.organizationId,
          technicianId,
          skillId: skill.id,
          grantedById: actor.actorUserId,
          expiresAt,
          note: input.note?.trim() || null,
        },
        update: {
          grantedById: actor.actorUserId,
          grantedAt: new Date(),
          expiresAt,
          note: input.note?.trim() || null,
          revokedAt: null,
          revokedById: null,
        },
        select: {
          id: true,
          expiresAt: true,
          grantedAt: true,
          revokedAt: true,
          skill: { select: { id: true, key: true, label: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          ...actor,
          action: 'TECHNICIAN_SKILL_GRANTED',
          entityType: 'UserProfile',
          entityId: technicianId,
          metadata: {
            skillId: skill.id,
            skillKey: skill.key,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
      });

      return grant;
    });
  }

  async revoke(user: AuthenticatedUser, technicianId: string, skillId: string, reason?: string) {
    await this.requireTechnician(user.organizationId, technicianId);
    const skill = await this.requireSkill(user.organizationId, skillId);
    const actor = auditActor(user);

    return this.prisma.$transaction(async (tx) => {
      // `revokedAt: null` in the WHERE so revoking twice is a no-op rather than
      // moving the timestamp forward and rewriting when it happened.
      const { count } = await tx.technicianSkillGrant.updateMany({
        where: {
          organizationId: user.organizationId,
          technicianId,
          skillId,
          revokedAt: null,
        },
        data: { revokedAt: new Date(), revokedById: actor.actorUserId },
      });
      if (count === 0)
        throw new ApplicationError(
          409,
          'SKILL_NOT_HELD',
          'That technician does not currently hold this skill.',
        );

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          ...actor,
          action: 'TECHNICIAN_SKILL_REVOKED',
          entityType: 'UserProfile',
          entityId: technicianId,
          metadata: { skillId, skillKey: skill.key, reason: reason?.trim() || null },
        },
      });

      return { revoked: true };
    });
  }

  // ----------------------------------------------------------- requirements

  async requirements(user: AuthenticatedUser) {
    return this.prisma.inspectionTypeSkillRequirement.findMany({
      where: { organizationId: user.organizationId },
      orderBy: [{ inspectionType: 'asc' }, { requirement: 'asc' }],
      select: {
        id: true,
        inspectionType: true,
        requirement: true,
        skill: { select: { id: true, key: true, label: true, isActive: true } },
      },
    });
  }

  async setRequirement(user: AuthenticatedUser, input: SetSkillRequirementDto) {
    const skill = await this.requireSkill(user.organizationId, input.skillId);
    return this.prisma.inspectionTypeSkillRequirement.upsert({
      where: {
        organizationId_inspectionType_skillId: {
          organizationId: user.organizationId,
          inspectionType: input.inspectionType,
          skillId: skill.id,
        },
      },
      create: {
        organizationId: user.organizationId,
        inspectionType: input.inspectionType,
        skillId: skill.id,
        requirement: input.requirement,
      },
      update: { requirement: input.requirement },
      select: {
        id: true,
        inspectionType: true,
        requirement: true,
        skill: { select: { id: true, key: true, label: true } },
      },
    });
  }

  async removeRequirement(
    user: AuthenticatedUser,
    inspectionType: InspectionType,
    skillId: string,
  ) {
    const { count } = await this.prisma.inspectionTypeSkillRequirement.deleteMany({
      where: { organizationId: user.organizationId, inspectionType, skillId },
    });
    if (count === 0)
      throw new ApplicationError(404, 'REQUIREMENT_NOT_FOUND', 'That requirement was not found.');
    return { removed: true };
  }

  // ---------------------------------------------------------- qualification

  /**
   * Which technicians may take this kind of inspection on this day.
   *
   * `onDate` is the day of the *visit*, never today. A quarterly plan is built
   * three months ahead, so a certificate lapsing in week six has to disqualify
   * week seven onward - evaluating against now would put somebody on a job they
   * are no longer licensed for by the time they arrive at it.
   *
   * **A type with no requirements qualifies every active technician**, and that
   * default is load-bearing rather than convenient. Requirements start empty in
   * every organization, so the opposite default would mean switching this
   * feature on makes every inspection unassignable until somebody fills in a
   * matrix nobody has been told about.
   */
  async qualifiedTechnicians(
    organizationId: string,
    inspectionType: InspectionType,
    onDate: Date,
  ): Promise<QualifiedTechnician[]> {
    const inputs = await this.qualificationInputs(organizationId, inspectionType);
    return qualifyOn(inputs, onDate);
  }

  /**
   * The same question asked about every working day of a quarter.
   *
   * One set of queries rather than one per date. A quarter has about sixty-two
   * working days, and asking separately would be sixty-two round trips to learn
   * something that changes only when a certificate lapses — while holding the
   * answer for a whole quarter costs a few dozen rows.
   */
  async qualificationCalendar(
    organizationId: string,
    inspectionType: InspectionType,
    dates: readonly Date[],
  ): Promise<Map<string, QualifiedTechnician[]>> {
    const inputs = await this.qualificationInputs(organizationId, inspectionType);
    return new Map(
      dates.map((date) => [date.toISOString().slice(0, 10), qualifyOn(inputs, date)]),
    );
  }

  /**
   * Everything qualification depends on, fetched once.
   *
   * Expiry is applied in `qualifyOn` rather than in this query, deliberately:
   * the rule is date-relative, and pushing it into SQL would mean one query per
   * date. The set is small — technicians times the skills one inspection type
   * asks for — so holding it and evaluating in memory is both cheaper and
   * directly testable.
   */
  private async qualificationInputs(organizationId: string, inspectionType: InspectionType) {
    const requirements = await this.prisma.inspectionTypeSkillRequirement.findMany({
      where: { organizationId, inspectionType, skill: { isActive: true } },
      select: { skillId: true, requirement: true },
    });
    const required = requirements
      .filter((rule) => rule.requirement === SkillRequirementLevel.REQUIRED)
      .map((rule) => rule.skillId);
    const preferred = requirements
      .filter((rule) => rule.requirement === SkillRequirementLevel.PREFERRED)
      .map((rule) => rule.skillId);

    const technicians = await this.prisma.userProfile.findMany({
      where: {
        isActive: true,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });

    const grants =
      required.length || preferred.length
        ? await this.prisma.technicianSkillGrant.findMany({
            where: {
              organizationId,
              technicianId: { in: technicians.map((technician) => technician.id) },
              skillId: { in: [...required, ...preferred] },
              revokedAt: null,
            },
            select: { technicianId: true, skillId: true, expiresAt: true },
          })
        : [];

    return { required, preferred, technicians, grants };
  }

  // ---------------------------------------------------------------- helpers

  private async requireSkill(organizationId: string, skillId: string) {
    const skill = await this.prisma.technicianSkill.findFirst({
      where: { id: skillId, organizationId },
      select: { id: true, key: true, isActive: true },
    });
    if (!skill) throw new ApplicationError(404, 'SKILL_NOT_FOUND', 'That skill was not found.');
    return skill;
  }

  /**
   * The same predicate `AdminService.requireTechnician` uses, and it has to
   * stay the same one: a person this refuses but assignment accepts could be
   * granted a skill they can never be scheduled with, and the reverse would
   * quietly drop somebody out of every plan.
   */
  private async requireTechnician(organizationId: string, technicianId: string) {
    const technician = await this.prisma.userProfile.findFirst({
      where: {
        id: technicianId,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true },
    });
    if (!technician)
      throw new ApplicationError(404, 'TECHNICIAN_NOT_FOUND', 'That technician was not found.');
    return technician;
  }
}
