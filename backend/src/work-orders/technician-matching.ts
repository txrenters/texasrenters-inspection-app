import type { TechnicianSkillLevel } from '@prisma/client';

/**
 * Who a work order goes to, once the AI has said which skills it needs and
 * whether it is a minor or a major job.
 *
 * The office's rule (2026-11-24), from the Technicians' Scope of Work sheet:
 *
 * - an N is never sent. A technician must hold **every** skill the job needs;
 * - a plain Y beats a Y with a limit ("MINOR REPAIRS ONLY"), which beats a Y
 *   marked "NEEDS IMPROVEMENT". Needs-improvement is the last resort: chosen
 *   only when nobody holds the skills any better;
 * - a limit means minor work, so a LIMITED technician is not sent to a major
 *   job at all.
 *
 * Among equals, whoever already has a job within ten miles that day, closest
 * first, so a technician's day stays in one cluster (the office, 2026-11-25:
 * "clusters of existing job, and close to the job"). Skill always comes
 * first: a nearby technician never beats a better-skilled one. Then whoever
 * has fewer visits that day, then by name so the same inputs always pick the
 * same person.
 *
 * Distance is straight-line between the properties' stored coordinates,
 * worked out here: no map provider is asked, so matching costs nothing however
 * many work orders arrive.
 *
 * Pure, so the rule can be argued with in a test. The AI never sees this list
 * and never picks the person; it only says what the job is.
 */

export type JobScope = 'MINOR' | 'MAJOR';

/** A job this close, or closer, keeps a technician's day in one cluster. */
export const NEARBY_MILES = 10;

export interface MatchSkill {
  id: string;
  label: string;
}

export interface MatchGrant {
  technicianId: string;
  skillId: string;
  level: TechnicianSkillLevel;
  note: string | null;
}

export interface MatchTechnician {
  id: string;
  displayName: string;
  /** Visits already on the technician for the visit's day. */
  load: number;
  /**
   * Miles from the work order to the nearest of those visits, straight line.
   * Null when they have none with a known place; absent when the work order's
   * own place is unknown, so nothing could be measured.
   */
  nearestMiles?: number | null;
}

export interface RankedTechnician {
  technicianId: string;
  displayName: string;
  /** 1 every skill FULL, 2 some LIMITED, 3 some NEEDS_IMPROVEMENT; null when not eligible. */
  tier: 1 | 2 | 3 | null;
  load: number;
  nearestMiles?: number | null;
  /** Each needed skill and how this person holds it; null is an N. */
  skills: { label: string; level: TechnicianSkillLevel | null; note: string | null }[];
  /** Why they were passed over; null for the eligible. */
  excludedBecause: string | null;
}

export interface MatchResult {
  picked: RankedTechnician | null;
  /** Eligible first, best first; then everyone passed over. */
  ranking: RankedTechnician[];
}

const TIER: Record<TechnicianSkillLevel, 1 | 2 | 3> = {
  FULL: 1,
  LIMITED: 2,
  NEEDS_IMPROVEMENT: 3,
};

export function rankWorkOrderTechnicians(input: {
  skills: MatchSkill[];
  scope: JobScope;
  technicians: MatchTechnician[];
  grants: MatchGrant[];
}): MatchResult {
  const { skills, scope, technicians, grants } = input;
  const held = new Map<string, MatchGrant>();
  for (const grant of grants) held.set(`${grant.technicianId}:${grant.skillId}`, grant);

  const ranking = technicians.map((technician): RankedTechnician => {
    const mine = skills.map((skill) => {
      const grant = held.get(`${technician.id}:${skill.id}`);
      return { label: skill.label, level: grant?.level ?? null, note: grant?.note ?? null };
    });
    const missing = mine.filter((skill) => skill.level === null).map((skill) => skill.label);
    const minorOnly = mine.filter((skill) => skill.level === 'LIMITED').map((skill) => skill.label);
    const excludedBecause = missing.length
      ? `not marked for ${missing.join(', ')}`
      : scope === 'MAJOR' && minorOnly.length
        ? `limited on ${minorOnly.join(', ')}, and this is a major job`
        : null;
    const tier = excludedBecause
      ? null
      : (Math.max(1, ...mine.map((skill) => TIER[skill.level!])) as 1 | 2 | 3);
    return {
      technicianId: technician.id,
      displayName: technician.displayName,
      tier,
      load: technician.load,
      nearestMiles: technician.nearestMiles,
      skills: mine,
      excludedBecause,
    };
  });

  const nearby = (r: RankedTechnician) => (r.nearestMiles != null && r.nearestMiles <= NEARBY_MILES ? r.nearestMiles : null);
  ranking.sort((a, b) => {
    const [an, bn] = [nearby(a), nearby(b)];
    return (
      (a.tier ?? 9) - (b.tier ?? 9) ||
      // Nearby before not, then the closer of two nearby.
      Number(an === null) - Number(bn === null) ||
      (an !== null && bn !== null ? an - bn : 0) ||
      a.load - b.load ||
      a.displayName.localeCompare(b.displayName)
    );
  });
  const picked = skills.length && ranking[0]?.tier ? ranking[0] : null;
  return { picked, ranking };
}

/** The office-facing line for who was picked and on what. */
export function pickedReason(picked: RankedTechnician, scope: JobScope): string {
  const held = picked.skills
    .map((skill) => {
      const how =
        skill.level === 'FULL' ? null : skill.level === 'LIMITED' ? 'limited' : 'needs improvement';
      const detail = [how, skill.note].filter(Boolean).join(': ');
      return detail ? `${skill.label} (${detail})` : skill.label;
    })
    .join(', ');
  const fallback = picked.tier === 3 ? ' -- nobody holds this any better' : '';
  // Said only when it could be measured: the work order's place is known.
  const where =
    picked.nearestMiles === undefined
      ? ''
      : picked.nearestMiles !== null && picked.nearestMiles <= NEARBY_MILES
        ? `; already working ${picked.nearestMiles.toFixed(1)} mi away (${picked.load} ${picked.load === 1 ? 'job' : 'jobs'} that day)`
        : `; no job within ${NEARBY_MILES} miles that day, fewest visits`;
  return `${picked.displayName}: ${held}; ${scope.toLowerCase()} job${fallback}${where}.`;
}
