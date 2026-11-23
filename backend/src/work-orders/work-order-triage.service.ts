import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  InspectionSource,
  InspectionStatus,
  Prisma,
  UserRole,
  WorkOrderImportStatus,
  WorkOrderTriageOutcome,
} from '@prisma/client';
import { z } from 'zod';

import { AdminService } from '../admin/admin.service';
import { AiProviderSettingsService } from '../admin/ai-provider-settings.service';
import type { AuthenticatedUser } from '../common/auth';
import { ceilingFrom, DailyAllowance, spendFrom } from '../common/daily-allowance';
import { PrismaService } from '../common/prisma.service';
import { withTenant } from '../database/tenant-context';
import { crewFilter } from './work-order-crew';
import { askAi, jsonIn } from '../technician/ai-text';
import { workOrderHandoffSchema, type WorkOrderHandoff } from './work-order-handoff.schema';
import {
  pickedReason,
  rankWorkOrderTechnicians,
  type JobScope,
  type MatchSkill,
} from './technician-matching';

/**
 * Puts a handed-over work order on the technician who fits it.
 *
 * The AI reads the work order -- category, type, description, the notes and
 * the maintenance app's summary of the messages -- and answers which skills
 * from the office's catalog the job needs, whether it is minor or major, and
 * how sure it is. That answer is checked against the catalog; anything else
 * is thrown away. Who goes is then decided by `rankWorkOrderTechnicians`, not
 * by the AI, and the visit is assigned at once (the office's choice,
 * 2026-11-24), to be moved by hand if it is wrong.
 *
 * Billed calls: one AI reading per work order. A re-send with the same text
 * reuses the reading it already has (`inputHash`), a visit that already has a
 * technician is not read at all, and every reading is counted against a daily
 * ceiling (`WORK_ORDER_TRIAGE_DAILY_CEILING`, 300), past which the work order
 * is left for the office rather than read.
 *
 * **Trial mode is the default.** Unless `WORK_ORDER_AUTO_ASSIGN=assign`, the
 * pick is recorded as SUGGESTED -- "would assign Kevin, because..." on the
 * work order -- and nobody is assigned, notified or pushed to Jobber. The
 * office asked for that (2026-11-24): check the picks against real work
 * orders before the app sends anyone.
 *
 * Runs after the maintenance app has had its answer, so a slow AI never makes
 * the hand-off time out. A reading that fails leaves the visit unassigned with
 * the reason on it, which is where every work order started before this.
 */

/**
 * v2 (2026-11-24): the fewest job types, not every related one. v1 read a water
 * heater replacement as Water heater + Water leak + Plumbing, and the two
 * technicians cleared to replace heaters -- minor-only on general plumbing --
 * were ruled out of a major job they are the ones for.
 */
export const TRIAGE_PROMPT_VERSION = 'work-order-triage-v2';
export const DAILY_TRIAGE_READINGS = 300;
/** Below this the AI is guessing, and a guess sends someone to the wrong home. */
export const MIN_CONFIDENCE = 60;
const MAX_SKILLS = 4;
/** How many waiting work orders one "check open work orders" press reads, at most. */
export const OPEN_CHECK_LIMIT = 100;

/** Whether a pick is acted on, or only recorded for the office to check. */
export function autoAssignLive(): boolean {
  return process.env.WORK_ORDER_AUTO_ASSIGN?.trim().toLowerCase() === 'assign';
}

/** Why there is no reading to match on. */
type NoReading = typeof WorkOrderTriageOutcome.AI_FAILED | typeof WorkOrderTriageOutcome.DAILY_LIMIT;

const readingSchema = z.object({
  skills: z.array(z.string().trim().min(1).max(80)).max(10),
  scope: z.enum(['MINOR', 'MAJOR']),
  confidence: z.number().min(0).max(100),
  summary: z.string().trim().max(300).default(''),
});

export interface TriageReading {
  skillKeys: string[];
  scope: JobScope;
  confidence: number;
  summary: string;
}

/** The work order as the AI reads it. No tenant names, phones or emails. */
export function triageText(handoff: WorkOrderHandoff): string {
  const wo = handoff.work_order;
  const lines = [
    wo.category ? `Category: ${wo.category}` : null,
    wo.type ? `Type: ${wo.type}` : null,
    wo.is_emergency ? 'Marked emergency' : null,
    wo.specific_location ? `Location: ${wo.specific_location}` : null,
    wo.description?.trim() ? `Description: ${wo.description.trim()}` : null,
    handoff.messages_summary ? `Messages summary: ${handoff.messages_summary.summary}` : null,
    handoff.approval?.problems.length
      ? `Items: ${handoff.approval.problems.map((problem) => problem.item).join('; ')}`
      : null,
    ...(handoff.notes ?? [])
      .slice(0, 10)
      .map((note) => `Note: ${[note.subject, note.body].filter(Boolean).join(' - ').slice(0, 500)}`),
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n').slice(0, 6000);
}

export function triagePrompt(text: string, catalog: { key: string; label: string }[]): string {
  return [
    'You read a property maintenance work order and say what kind of work it is,',
    'so the right technician can be sent. Choose ONLY from this list of job types (key: name):',
    ...catalog.map((skill) => `- ${skill.key}: ${skill.label}`),
    '',
    'Rules:',
    '- "skills": the FEWEST keys that describe the work to be done -- usually exactly one, the most specific (a leaking kitchen faucet is ["faucet-leak"]; a water heater replacement is ["water-heater"]; a dishwasher that will not drain is ["dishwasher"]).',
    '  Do not add a general type ("plumbing", "electrical", "drainage", "water-leak") when a specific one already covers the job, and do not add types for symptoms of the same problem.',
    `  Add a second key only when the work order asks for a genuinely separate piece of work (patch walls AND repaint: ["sheetrock-repairs", "interior-paint"]). At most ${MAX_SKILLS}. Use keys exactly as listed. Empty if nothing fits.`,
    '- "scope": "MINOR" for a small repair, adjustment, clog, part swap or check; "MAJOR" for a replacement, installation, a large or structural repair, or anything that needs a licensed trade.',
    '- "confidence": 0-100, how sure you are of the skills. Below 60 if the text is too vague to tell.',
    '- "summary": one short sentence saying what the problem is.',
    'Answer with JSON only: {"skills": [...], "scope": "MINOR", "confidence": 80, "summary": "..."}',
    '',
    'Work order:',
    text,
  ].join('\n');
}

/** The AI's answer, kept only as far as it names skills in the catalog. Null when it does not parse. */
export function parseReading(answer: string, catalogKeys: ReadonlySet<string>): TriageReading | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonIn(answer, '{'));
  } catch {
    return null;
  }
  const parsed = readingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const skillKeys = [...new Set(parsed.data.skills.map((key) => key.toLowerCase()))]
    .filter((key) => catalogKeys.has(key))
    .slice(0, MAX_SKILLS);
  return {
    skillKeys,
    scope: parsed.data.scope,
    confidence: Math.round(parsed.data.confidence),
    summary: parsed.data.summary,
  };
}

@Injectable()
export class WorkOrderTriageService {
  private readonly logger = new Logger(WorkOrderTriageService.name);
  private readonly readingsToday = new DailyAllowance(
    'work-order-triage',
    ceilingFrom('WORK_ORDER_TRIAGE_DAILY_CEILING', DAILY_TRIAGE_READINGS),
  );

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Optional()
    @Inject(AiProviderSettingsService)
    private readonly aiSettings?: AiProviderSettingsService,
  ) {}

  /** Started after the hand-off is answered; never throws. */
  runInBackground(actor: AuthenticatedUser, inspectionId: string, handoff: WorkOrderHandoff) {
    void withTenant(actor.organizationId, () => this.triage(actor, inspectionId, handoff)).catch(
      (error: unknown) =>
        this.logger.error(
          `Work order triage failed for ${inspectionId}`,
          error instanceof Error ? error.stack : String(error),
        ),
    );
  }

  async triage(actor: AuthenticatedUser, inspectionId: string, handoff: WorkOrderHandoff) {
    const organizationId = actor.organizationId;
    const inspection = await this.prisma.inspection.findFirst({
      where: { id: inspectionId, organizationId },
      select: {
        status: true,
        scheduledAt: true,
        assignments: { where: { isCurrent: true }, select: { id: true }, take: 1 },
        workOrderTriage: { select: { inputHash: true, skillKeys: true, scope: true, confidence: true, summary: true, outcome: true } },
      },
    });
    // Nothing to send anyone to, or somebody is already going: no reading, no cost.
    if (!inspection || inspection.status !== InspectionStatus.SCHEDULED) return null;
    if (inspection.assignments.length) return null;

    const catalog = await this.prisma.technicianSkill.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, key: true, label: true },
      orderBy: { label: 'asc' },
    });
    const text = triageText(handoff);
    const inputHash = createHash('sha256')
      .update(TRIAGE_PROMPT_VERSION)
      .update('\n')
      .update(catalog.map((skill) => skill.key).join(','))
      .update('\n')
      .update(text)
      .digest('hex');

    if (!catalog.length)
      return this.record(organizationId, inspectionId, inputHash, {
        outcome: WorkOrderTriageOutcome.NOT_CONFIGURED,
        reason: 'No technician skills are set up yet, so the work order was left for the office.',
      });

    const stored = inspection.workOrderTriage;
    const reusable =
      stored?.inputHash === inputHash &&
      stored.outcome !== WorkOrderTriageOutcome.AI_FAILED &&
      stored.outcome !== WorkOrderTriageOutcome.DAILY_LIMIT &&
      stored.scope !== null &&
      stored.confidence !== null;
    const reading: TriageReading | NoReading = reusable
      ? {
          skillKeys: stored.skillKeys,
          scope: stored.scope as JobScope,
          confidence: stored.confidence!,
          summary: stored.summary ?? '',
        }
      : await this.read(organizationId, inspectionId, text, catalog);

    if (reading === WorkOrderTriageOutcome.DAILY_LIMIT)
      return this.record(organizationId, inspectionId, inputHash, {
        outcome: reading,
        reason: "Today's limit of AI work-order readings is used up; the office assigns this one.",
      });
    if (reading === WorkOrderTriageOutcome.AI_FAILED)
      return this.record(organizationId, inspectionId, inputHash, {
        outcome: reading,
        reason: 'The AI could not read this work order; the office assigns it.',
      });

    const facts = {
      skillKeys: reading.skillKeys,
      scope: reading.scope,
      confidence: reading.confidence,
      summary: reading.summary || null,
    };
    if (!reading.skillKeys.length || reading.confidence < MIN_CONFIDENCE)
      return this.record(organizationId, inspectionId, inputHash, {
        ...facts,
        outcome: WorkOrderTriageOutcome.LOW_CONFIDENCE,
        reason: reading.skillKeys.length
          ? `The AI was only ${reading.confidence}% sure what this job is; the office assigns it.`
          : 'The AI could not match this work order to any job type; the office assigns it.',
      });

    const skills: MatchSkill[] = reading.skillKeys.map((key) => {
      const skill = catalog.find((entry) => entry.key === key)!;
      return { id: skill.id, label: skill.label };
    });
    const result = await this.rank(organizationId, inspection.scheduledAt, skills, reading.scope);
    const ranking = result.ranking as unknown as Prisma.InputJsonValue;

    if (!result.picked)
      return this.record(organizationId, inspectionId, inputHash, {
        ...facts,
        ranking,
        outcome: WorkOrderTriageOutcome.NO_FIT,
        reason: `Nobody is marked for ${skills.map((skill) => skill.label).join(' + ')} on a ${reading.scope.toLowerCase()} job; the office assigns it.`,
      });

    const reason = pickedReason(result.picked, reading.scope);
    if (!autoAssignLive())
      return this.record(organizationId, inspectionId, inputHash, {
        ...facts,
        ranking,
        outcome: WorkOrderTriageOutcome.SUGGESTED,
        technicianId: result.picked.technicianId,
        reason: `Would assign ${reason}`,
      });
    const assigned = await this.admin.autoAssignWorkOrder(actor, inspectionId, result.picked.technicianId, {
      workOrderKey: handoff.idempotency_key,
      skills: reading.skillKeys,
      scope: reading.scope,
      confidence: reading.confidence,
      tier: result.picked.tier,
      reason,
    });
    return this.record(organizationId, inspectionId, inputHash, {
      ...facts,
      ranking,
      outcome: assigned ? WorkOrderTriageOutcome.ASSIGNED : WorkOrderTriageOutcome.ALREADY_ASSIGNED,
      technicianId: assigned ? result.picked.technicianId : null,
      reason: assigned ? reason : 'Someone was put on the visit before the match finished; nobody was moved.',
    });
  }

  /**
   * Matches the work orders already waiting: scheduled, nobody on them, from
   * the maintenance app. For work orders that arrived before matching existed.
   *
   * At most `OPEN_CHECK_LIMIT` a press, one at a time, each under the same
   * daily ceiling; one already read with the same text is not read again, so
   * pressing twice costs nothing the second time.
   */
  async matchOpen(actor: AuthenticatedUser) {
    const visits = await this.prisma.inspection.findMany({
      where: {
        organizationId: actor.organizationId,
        source: InspectionSource.WORK_ORDER,
        status: InspectionStatus.SCHEDULED,
        assignments: { none: { isCurrent: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: OPEN_CHECK_LIMIT,
      select: {
        id: true,
        workOrderImports: {
          where: { status: WorkOrderImportStatus.PROCESSED },
          orderBy: { lastReceivedAt: 'desc' },
          take: 1,
          select: { payload: true },
        },
      },
    });
    const outcomes: Record<string, number> = {};
    for (const visit of visits) {
      const parsed = workOrderHandoffSchema.safeParse(visit.workOrderImports[0]?.payload);
      if (!parsed.success) continue;
      const row = await this.triage(actor, visit.id, parsed.data);
      if (row) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
    }
    return { checked: visits.length, outcomes };
  }

  private async read(
    organizationId: string,
    inspectionId: string,
    text: string,
    catalog: { key: string; label: string }[],
  ): Promise<TriageReading | NoReading> {
    if (!this.aiSettings) return WorkOrderTriageOutcome.AI_FAILED;
    if (!spendFrom(1, [this.readingsToday], this.logger)) return WorkOrderTriageOutcome.DAILY_LIMIT;
    try {
      const configuration = await this.aiSettings.resolve(organizationId);
      const { text: answer, usage } = await askAi(configuration, triagePrompt(text, catalog), {
        maxTokens: 400,
        timeoutMs: 45_000,
        failureCode: 'AI_WORK_ORDER_TRIAGE_FAILED',
        onRejected: (status, message) =>
          this.logger.warn(`Work order triage rejected (HTTP ${status}): ${message}`),
      });
      await this.aiSettings
        .recordUsage(organizationId, configuration, 'WORK_ORDER_TRIAGE', usage, inspectionId)
        .catch(() => undefined);
      return parseReading(answer, new Set(catalog.map((skill) => skill.key))) ?? WorkOrderTriageOutcome.AI_FAILED;
    } catch (error) {
      this.logger.warn(
        `Work order triage skipped for ${inspectionId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return WorkOrderTriageOutcome.AI_FAILED;
    }
  }

  /** Every active technician, the grants good on the visit's day, and how full that day already is. */
  private async rank(organizationId: string, day: Date, skills: MatchSkill[], scope: JobScope) {
    const dayStart = new Date(`${day.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    // The office's work-order crew, when it has picked one; everyone otherwise.
    const crew = await crewFilter(this.prisma, organizationId);
    const technicians = await this.prisma.userProfile.findMany({
      where: {
        isActive: true,
        memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        ...(crew ? { id: { in: crew } } : {}),
      },
      select: { id: true, displayName: true },
    });
    const ids = technicians.map((technician) => technician.id);
    const [grants, loads] = await Promise.all([
      this.prisma.technicianSkillGrant.findMany({
        where: {
          organizationId,
          technicianId: { in: ids },
          skillId: { in: skills.map((skill) => skill.id) },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gte: dayStart } }],
        },
        select: { technicianId: true, skillId: true, level: true, note: true },
      }),
      this.prisma.inspectionAssignment.groupBy({
        by: ['technicianId'],
        where: {
          isCurrent: true,
          technicianId: { in: ids },
          inspection: {
            organizationId,
            scheduledAt: { gte: dayStart, lt: dayEnd },
            status: { not: InspectionStatus.CANCELLED },
          },
        },
        _count: { _all: true },
      }),
    ]);
    const load = new Map(loads.map((row) => [row.technicianId, row._count._all]));
    return rankWorkOrderTechnicians({
      skills,
      scope,
      grants,
      technicians: technicians.map((technician) => ({
        ...technician,
        load: load.get(technician.id) ?? 0,
      })),
    });
  }

  private record(
    organizationId: string,
    inspectionId: string,
    inputHash: string,
    row: {
      outcome: WorkOrderTriageOutcome;
      reason: string;
      skillKeys?: string[];
      scope?: JobScope | null;
      confidence?: number | null;
      summary?: string | null;
      technicianId?: string | null;
      ranking?: Prisma.InputJsonValue;
    },
  ) {
    const data = {
      inputHash,
      promptVersion: TRIAGE_PROMPT_VERSION,
      outcome: row.outcome,
      reason: row.reason,
      skillKeys: row.skillKeys ?? [],
      scope: row.scope ?? null,
      confidence: row.confidence ?? null,
      summary: row.summary ?? null,
      technicianId: row.technicianId ?? null,
      ranking: row.ranking ?? Prisma.DbNull,
    };
    return this.prisma.workOrderTriage.upsert({
      where: { inspectionId },
      create: { organizationId, inspectionId, ...data },
      update: data,
    });
  }
}
