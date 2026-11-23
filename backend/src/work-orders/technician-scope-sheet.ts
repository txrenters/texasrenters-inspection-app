import { Inject, Injectable } from '@nestjs/common';
import { TechnicianSkillLevel, UserRole } from '@prisma/client';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { TECHNICIAN_SCOPE_SHEET } from './technician-scope-sheet.data';

/**
 * The office's Technicians' Scope of Work sheet, loaded as skills and grants.
 *
 * Every job type on the sheet becomes a skill. A Y becomes a grant whose level
 * comes from the remark beside it (`levelFor`); an N becomes nothing.
 * Technicians are matched by display name, case and spacing aside, among the
 * organization's active inspection technicians. Anyone not found is reported
 * and left out, never created: making a login is the office's step.
 *
 * Safe to run again: skills are keyed by slug and grants by person and skill,
 * so a second run updates levels and notes in place, and a Y turned N is
 * revoked rather than deleted.
 */

export interface ScopeSheet {
  technicians: string[];
  rows: { job: string; marks: Record<string, { mark: string; remark: string }> }[];
}

export interface SheetGrant {
  technician: string;
  skillKey: string;
  level: TechnicianSkillLevel;
  note: string | null;
}

/** Remarks that widen a Y rather than limit it. */
const FULL_REMARKS = [/^CAN REPLACE/i, /^CAN COMPLETE/i];

/**
 * How a Y's remark reads, per the office (2026-11-24): none, or a "can do more"
 * remark, is FULL; "NEEDS IMPROVEMENT" is the last resort; any other remark --
 * "MINOR REPAIRS ONLY", "SPOT CLEANING ONLY", "IF LAWN MOWER IS PROVIDED" -- is
 * a limit. Null is no grant: an N, a blank, or a blank mark with "N" typed into
 * the remark column, as the sheet has for two Thermostat cells.
 */
export function levelFor(mark: string, remark: string): TechnicianSkillLevel | null {
  if (mark.trim().toUpperCase() !== 'Y') return null;
  const text = remark.trim();
  if (!text) return TechnicianSkillLevel.FULL;
  if (/NEEDS IMPROVEMENT/i.test(text)) return TechnicianSkillLevel.NEEDS_IMPROVEMENT;
  if (FULL_REMARKS.some((pattern) => pattern.test(text))) return TechnicianSkillLevel.FULL;
  return TechnicianSkillLevel.LIMITED;
}

/** "Turnover - see Original Turnover" is the same job as "Turnover". */
const SAME_JOB: Record<string, string> = {
  'turnover-see-original-turnover': 'turnover',
};

export function skillKeyFor(job: string): string {
  const key = job
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return SAME_JOB[key] ?? key;
}

/**
 * The sheet as skills and grants. A job listed twice ("Interior Paint", "Glass
 * Window") is one skill; where the two rows disagree, the better level wins.
 */
export function readScopeSheet(sheet: ScopeSheet) {
  const skills = new Map<string, string>();
  const grants = new Map<string, SheetGrant>();
  const rank = { FULL: 1, LIMITED: 2, NEEDS_IMPROVEMENT: 3 } as const;
  for (const row of sheet.rows) {
    const skillKey = skillKeyFor(row.job);
    if (!skillKey) continue;
    if (!skills.has(skillKey)) skills.set(skillKey, row.job.trim());
    for (const technician of sheet.technicians) {
      const cell = row.marks[technician];
      const level = cell ? levelFor(cell.mark, cell.remark) : null;
      if (!level) continue;
      const id = `${technician}:${skillKey}`;
      const previous = grants.get(id);
      if (previous && rank[previous.level] <= rank[level]) continue;
      grants.set(id, { technician, skillKey, level, note: cell.remark.trim() || null });
    }
  }
  return {
    skills: [...skills].map(([key, label]) => ({ key, label })),
    grants: [...grants.values()],
  };
}

const normalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export interface ScopeSheetImportResult {
  applied: boolean;
  skills: number;
  marks: number;
  found: string[];
  missing: string[];
}

@Injectable()
export class TechnicianScopeSheetService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Says what an import would do; writes only when `apply`. */
  async import(user: AuthenticatedUser, apply: boolean): Promise<ScopeSheetImportResult> {
    const organizationId = user.organizationId;
    const sheet = TECHNICIAN_SCOPE_SHEET;
    const { skills, grants } = readScopeSheet(sheet);
    const people = await this.prisma.userProfile.findMany({
      where: {
        isActive: true,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
      },
      select: { id: true, displayName: true },
    });
    const byName = new Map(people.map((person) => [normalName(person.displayName), person.id]));
    const found = sheet.technicians.filter((name) => byName.has(normalName(name)));
    const missing = sheet.technicians.filter((name) => !byName.has(normalName(name)));
    const result = { applied: false, skills: skills.length, marks: grants.length, found, missing };
    if (!apply || !found.length) return result;

    await this.prisma.$transaction(
      async (tx) => {
        const skillIds = new Map<string, string>();
        for (const skill of skills) {
          const row = await tx.technicianSkill.upsert({
            where: { organizationId_key: { organizationId, key: skill.key } },
            create: { organizationId, key: skill.key, label: skill.label },
            update: { label: skill.label, isActive: true },
            select: { id: true },
          });
          skillIds.set(skill.key, row.id);
        }
        for (const name of found) {
          const technicianId = byName.get(normalName(name))!;
          const mine = grants.filter((grant) => grant.technician === name);
          const kept = new Set(mine.map((grant) => skillIds.get(grant.skillKey)!));
          for (const grant of mine) {
            const skillId = skillIds.get(grant.skillKey)!;
            await tx.technicianSkillGrant.upsert({
              where: { organizationId_technicianId_skillId: { organizationId, technicianId, skillId } },
              create: {
                organizationId,
                technicianId,
                skillId,
                level: grant.level,
                note: grant.note,
                grantedById: user.principalType === 'API_KEY' ? null : user.id,
              },
              update: { level: grant.level, note: grant.note, revokedAt: null, revokedById: null },
            });
          }
          // A Y the sheet has since turned to N.
          await tx.technicianSkillGrant.updateMany({
            where: {
              organizationId,
              technicianId,
              revokedAt: null,
              skillId: { in: [...skillIds.values()].filter((id) => !kept.has(id)) },
            },
            data: {
              revokedAt: new Date(),
              revokedById: user.principalType === 'API_KEY' ? null : user.id,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            organizationId,
            ...auditActor(user),
            action: 'TECHNICIAN_SKILLS_IMPORTED',
            entityType: 'Organization',
            entityId: organizationId,
            metadata: { skills: skills.length, marks: grants.length, technicians: found, missing },
          },
        });
      },
      { timeout: 60_000 },
    );
    return { ...result, applied: true };
  }
}
