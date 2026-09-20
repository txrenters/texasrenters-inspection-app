import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiProvider, TbpPlanStatus, TbpStopStatus, type InspectionType } from '@prisma/client';
import {
  MAX_LEG_MINUTES,
  dayVisitRange,
  estimatedDriveMinutes,
  shortestOpenPathOrder,
} from '@texasrenters/shared';

import { AiProviderSettingsService, type AiTokenUsage, type ResolvedAiConfiguration } from '../admin/ai-provider-settings.service';
import type { AuthenticatedUser } from '../common/auth';
import { auditActor } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { TechnicianSkillsService } from '../admin/technician-skills.service';
import { TbpStopEditService } from './tbp-stop-edit.service';

/**
 * What the office is told about its quarter, and the moves it is offered.
 *
 * The office (2026-09-20): "note that I am still finding the most effecient
 * grouping for this so can you integrate ai into this also cause I have openai
 * integrated already with the system".
 *
 * ## What AI does here, and what it does not
 *
 * It does **not** route. The grouping is already close to its floor -- three of
 * every five or six estimated minutes between two properties is the fixed cost
 * of arriving at all -- and a model asked to order stops does worse than the
 * 2-opt search in `quarter-assignment.ts`, more slowly and at a price per
 * quarter.
 *
 * What it does is the two things the search cannot:
 *
 * 1. **Say what is wrong with a day in words** (`notes`). "Wed 23 Dec mixes
 *    I-10 East with north-west Houston" is the sentence the office wrote
 *    themselves when they rejected a quarter, and nothing in the planner can
 *    write it.
 * 2. **Propose moves** (`moves`) the search would not try: it groups by
 *    driving, and a person reads a map by neighbourhood, road and river.
 *
 * ## Nothing the model says is trusted
 *
 * Every move is judged here, in code, against the office's own rules -- the day
 * it joins stays inside its visits, its six hours and the longest drive allowed
 * between two properties, the technician is qualified for it, and the two days
 * together must drive **less** than they do now. A move that fails any of those
 * is dropped with the reason, and the office sees what was proposed and what
 * survived. A model cannot put a visit anywhere the planner could not have put
 * it itself.
 *
 * Applying is a second call, with no AI in it: the office chooses which moves to
 * take, and each one is judged again before it is written, through the same edit
 * a coordinator makes by hand.
 */

/** How many days of the quarter are described to the model in one call. */
const DAYS_DESCRIBED = 80;

/** The most moves a reply may carry; anything past this is ignored. */
const MOVES_READ = 40;

/** A saving smaller than this, in estimated minutes, is noise rather than a better plan. */
const WORTH_MOVING_MINUTES = 1;

export interface AdvisedMove {
  stopId: string;
  address: string | null;
  fromDate: string | null;
  toDate: string;
  toTechnicianId: string;
  toTechnicianName: string;
  /** Estimated minutes the two days save together. */
  savedMinutes: number;
  /** The model's reason, kept as written. */
  why: string;
}

export interface RefusedMove {
  stopId: string;
  address: string | null;
  toDate: string;
  /** Why the plan's own rules refused it. */
  refused: string;
}

export interface PlanAdvice {
  /** What the model says is wrong with the quarter, in its own words. */
  notes: string[];
  /** How many moves it proposed. */
  proposed: number;
  moves: AdvisedMove[];
  refused: RefusedMove[];
  /** Estimated minutes the accepted moves save together. */
  savedMinutes: number;
  provider: AiProvider;
  modelId: string;
  usage?: AiTokenUsage;
}

export interface AppliedAdvice {
  applied: number;
  refused: RefusedMove[];
}

interface DayStop {
  id: string;
  address: string | null;
  zone: string | null;
  latitude: number;
  longitude: number;
  onSiteMinutes: number;
  inspectionType: InspectionType;
  date: string;
  technicianId: string;
}

interface PlanDay {
  date: string;
  technicianId: string;
  technicianName: string;
  anchors: number;
  stops: DayStop[];
}

const dayKey = (date: string, technicianId: string) => `${date}|${technicianId}`;
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** The estimated driving through a set of stops in their best open order, and its longest leg. */
function drive(stops: readonly { latitude: number; longitude: number }[]) {
  if (stops.length < 2) return { minutes: 0, longestLeg: 0 };
  const matrix = stops.map((one) => stops.map((other) => estimatedDriveMinutes(one, other)));
  const order = shortestOpenPathOrder(matrix);
  let minutes = 0;
  let longestLeg = 0;
  for (let index = 1; index < order.length; index += 1) {
    const leg = matrix[order[index - 1]!]![order[index]!]!;
    minutes += leg;
    longestLeg = Math.max(longestLeg, leg);
  }
  return { minutes, longestLeg };
}

@Injectable()
export class PlanAdvisorService {
  private readonly logger = new Logger(PlanAdvisorService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiProviderSettingsService) private readonly ai: AiProviderSettingsService,
    @Inject(TechnicianSkillsService) private readonly skills: TechnicianSkillsService,
    @Inject(TbpStopEditService) private readonly edits: TbpStopEditService,
  ) {}

  /** Read the quarter, ask the model, and keep only what the rules allow. */
  async advise(user: AuthenticatedUser, planId: string): Promise<PlanAdvice> {
    const { plan, days } = await this.read(user.organizationId, planId);
    if (!days.length)
      throw new ApplicationError(422, 'PLAN_HAS_NO_DAYS', 'Build the quarter before asking for advice on it.');

    const configuration = await this.ai.resolve(user.organizationId);
    const reply = await this.ask(configuration, plan, days);
    const judged = await this.judge(user.organizationId, plan, days, reply.moves);

    await this.ai
      .recordUsage(user.organizationId, configuration, 'tbp_plan_advice', reply.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, planId)
      .catch(() => undefined);
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action: 'TBP_PLAN_ADVICE_ASKED',
        entityType: 'TbpQuarterPlan',
        entityId: planId,
        metadata: {
          provider: configuration.provider,
          modelId: configuration.modelId,
          proposed: reply.moves.length,
          kept: judged.moves.length,
          savedMinutes: Math.round(judged.savedMinutes),
        },
      },
    });

    return {
      notes: reply.notes,
      proposed: reply.moves.length,
      moves: judged.moves,
      refused: judged.refused,
      savedMinutes: Math.round(judged.savedMinutes),
      provider: configuration.provider,
      modelId: configuration.modelId,
      usage: reply.usage,
    };
  }

  /**
   * Take the moves the office chose, judged again before anything is written.
   *
   * No AI in this call. The quarter may have changed since the advice -- a
   * coordinator moving a visit, or a rebuild -- so every move is measured
   * against the plan as it is now, and applied through the same edit a person
   * makes from the visit's window, which re-measures the days it touched.
   */
  async apply(
    user: AuthenticatedUser,
    planId: string,
    moves: readonly { stopId: string; toDate: string; toTechnicianId: string }[],
  ): Promise<AppliedAdvice> {
    const { plan, days } = await this.read(user.organizationId, planId);
    const judged = await this.judge(user.organizationId, plan, days, moves);

    let applied = 0;
    for (const move of judged.moves) {
      await this.edits.edit(user, move.stopId, {
        scheduledOn: move.toDate,
        assignedTechnicianId: move.toTechnicianId,
      });
      applied += 1;
    }

    if (applied)
      await this.prisma.auditLog.create({
        data: {
          organizationId: user.organizationId,
          ...auditActor(user),
          action: 'TBP_PLAN_ADVICE_APPLIED',
          entityType: 'TbpQuarterPlan',
          entityId: planId,
          metadata: { applied, savedMinutes: Math.round(judged.savedMinutes) },
        },
      });

    return { applied, refused: judged.refused };
  }

  /** The draft, and its days with the visits on them. */
  private async read(organizationId: string, planId: string) {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: {
        id: true,
        status: true,
        quarterYear: true,
        quarterNumber: true,
        minStopsPerDay: true,
        maxStopsPerDay: true,
        maxOnSiteMinutes: true,
        maxLegMinutes: true,
      },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This quarter has no plan.');
    if (plan.status !== TbpPlanStatus.DRAFT)
      throw new ApplicationError(409, 'PLAN_NOT_DRAFT', 'Only a draft quarter can be changed.');

    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: {
        planId,
        organizationId,
        status: TbpStopStatus.PLANNED,
        scheduledOn: { not: null },
        assignedTechnicianId: { not: null },
      },
      orderBy: [{ scheduledOn: 'asc' }, { positionInDay: 'asc' }],
      select: {
        id: true,
        zone: true,
        scheduledOn: true,
        assignedTechnicianId: true,
        onSiteMinutes: true,
        inspectionType: true,
        assignedTechnician: { select: { displayName: true } },
        propertywareBuilding: { select: { latitude: true, longitude: true } },
        tenant: { select: { addressLine1: true } },
      },
    });

    const anchors = await this.prisma.tbpQuarterPlanAnchor.findMany({
      where: { planId, organizationId },
      select: { date: true, technicianId: true },
    });
    const anchorsOn = new Map<string, number>();
    for (const anchor of anchors) {
      const key = dayKey(isoDay(anchor.date), anchor.technicianId);
      anchorsOn.set(key, (anchorsOn.get(key) ?? 0) + 1);
    }

    const days = new Map<string, PlanDay>();
    for (const row of rows) {
      // A property Propertyware has no location for cannot be judged on driving.
      if (row.propertywareBuilding?.latitude == null || row.propertywareBuilding.longitude == null) continue;
      const date = isoDay(row.scheduledOn!);
      const technicianId = row.assignedTechnicianId!;
      const key = dayKey(date, technicianId);
      const day =
        days.get(key) ??
        ({
          date,
          technicianId,
          technicianName: row.assignedTechnician?.displayName ?? 'Someone',
          anchors: anchorsOn.get(key) ?? 0,
          stops: [],
        } satisfies PlanDay);
      day.stops.push({
        id: row.id,
        address: row.tenant.addressLine1,
        zone: row.zone,
        latitude: Number(row.propertywareBuilding.latitude),
        longitude: Number(row.propertywareBuilding.longitude),
        onSiteMinutes: row.onSiteMinutes ?? 0,
        inspectionType: row.inspectionType,
        date,
        technicianId,
      });
      days.set(key, day);
    }

    return { plan, days: [...days.values()].sort((one, other) => one.date.localeCompare(other.date)) };
  }

  /**
   * Whether a move is one the planner could have made, and worth making.
   *
   * The day it joins is re-ordered and re-measured, as is the day it leaves,
   * both on the estimate the planner groups by. Nothing is accepted that breaks
   * a rule, and nothing that does not shorten the two days together.
   */
  private async judge(
    organizationId: string,
    plan: { minStopsPerDay: number; maxStopsPerDay: number; maxOnSiteMinutes: number; maxLegMinutes: number },
    days: readonly PlanDay[],
    proposed: readonly { stopId: string; toDate: string; toTechnicianId?: string | null; why?: string }[],
  ): Promise<{ moves: AdvisedMove[]; refused: RefusedMove[]; savedMinutes: number }> {
    const byKey = new Map(days.map((day) => [dayKey(day.date, day.technicianId), day]));
    const stopOf = new Map(days.flatMap((day) => day.stops.map((stop) => [stop.id, stop] as const)));
    const limits = {
      maxOnSiteMinutes: plan.maxOnSiteMinutes,
      minStopsPerDay: plan.minStopsPerDay,
      maxStopsPerDay: plan.maxStopsPerDay,
      maxLegMinutes: plan.maxLegMinutes,
    };
    // What each day holds while the moves are judged: one move must not be
    // accepted twice over the same free place.
    const holding = new Map<string, DayStop[]>(days.map((day) => [dayKey(day.date, day.technicianId), [...day.stops]]));

    const moves: AdvisedMove[] = [];
    const refused: RefusedMove[] = [];
    let savedMinutes = 0;

    for (const proposal of proposed.slice(0, MOVES_READ)) {
      const stop = stopOf.get(proposal.stopId);
      const address = stop?.address ?? null;
      const refuse = (why: string) => refused.push({ stopId: proposal.stopId, address, toDate: proposal.toDate, refused: why });
      if (!stop) {
        refuse('No visit in this quarter has that id.');
        continue;
      }
      const technicianId = proposal.toTechnicianId ?? null;
      const target = byKey.get(dayKey(proposal.toDate, technicianId ?? ''));
      if (!target) {
        refuse('That day and technician are not a day of this plan.');
        continue;
      }
      if (target.date === stop.date && target.technicianId === stop.technicianId) {
        refuse('It is already on that day.');
        continue;
      }

      const from = holding.get(dayKey(stop.date, stop.technicianId))!;
      const to = holding.get(dayKey(target.date, target.technicianId))!;
      const range = dayVisitRange(limits, target.anchors);
      if (to.length + 1 > range.max) {
        refuse(`That day already holds its ${range.max} visits.`);
        continue;
      }
      const onSite = to.reduce((total, one) => total + one.onSiteMinutes, 0) + stop.onSiteMinutes;
      if (onSite > plan.maxOnSiteMinutes) {
        refuse('That day would be over its six hours on site.');
        continue;
      }

      const qualified = await this.qualified(organizationId, stop.inspectionType, target.date, target.technicianId);
      if (!qualified) {
        refuse(`${target.technicianName} is not qualified for that visit on that day.`);
        continue;
      }

      const before = drive(from).minutes + drive(to).minutes;
      const left = from.filter((one) => one.id !== stop.id);
      const joined = [...to, stop];
      const after = drive(left);
      const arrived = drive(joined);
      if (arrived.longestLeg > (plan.maxLegMinutes || MAX_LEG_MINUTES)) {
        refuse(`It is more than ${plan.maxLegMinutes} minutes from that day's properties.`);
        continue;
      }
      const saved = before - (after.minutes + arrived.minutes);
      if (saved < WORTH_MOVING_MINUTES) {
        refuse('It would not shorten the driving.');
        continue;
      }

      holding.set(dayKey(stop.date, stop.technicianId), left);
      holding.set(dayKey(target.date, target.technicianId), joined);
      savedMinutes += saved;
      moves.push({
        stopId: stop.id,
        address,
        fromDate: stop.date,
        toDate: target.date,
        toTechnicianId: target.technicianId,
        toTechnicianName: target.technicianName,
        savedMinutes: Math.round(saved),
        why: (proposal.why ?? '').slice(0, 200),
      });
    }

    return { moves, refused, savedMinutes };
  }

  /** Whether a technician may take this kind of visit on that day, as the planner asks it. */
  private async qualified(organizationId: string, type: InspectionType, date: string, technicianId: string) {
    const calendar = await this.skills.qualificationCalendar(organizationId, type, [new Date(`${date}T00:00:00.000Z`)]);
    return (calendar.get(date) ?? []).some((candidate) => candidate.technicianId === technicianId);
  }

  /** The quarter as the model reads it: a line a day, a line a visit. */
  private describe(
    plan: { minStopsPerDay: number; maxStopsPerDay: number; maxOnSiteMinutes: number; maxLegMinutes: number },
    days: readonly PlanDay[],
  ) {
    const shown = days.slice(0, DAYS_DESCRIBED);
    const lines = shown.map((day) => {
      const measured = drive(day.stops);
      const head = `DAY ${day.date} ${day.technicianId} (${day.technicianName}) visits=${day.stops.length}${
        day.anchors ? ` move-outs=${day.anchors}` : ''
      } drive=${Math.round(measured.minutes)}min longest-leg=${Math.round(measured.longestLeg)}min`;
      const stops = day.stops.map(
        (stop) =>
          `  ${stop.id} ${stop.latitude.toFixed(4)},${stop.longitude.toFixed(4)} zone=${stop.zone ?? '-'} ${
            stop.onSiteMinutes
          }min ${stop.address ?? 'unknown address'}`,
      );
      return [head, ...stops].join('\n');
    });
    return { text: lines.join('\n'), shown: shown.length };
  }

  private prompt(
    plan: { minStopsPerDay: number; maxStopsPerDay: number; maxOnSiteMinutes: number; maxLegMinutes: number },
    days: readonly PlanDay[],
  ) {
    const described = this.describe(plan, days);
    return [
      'You are helping a Houston property-management office review a quarter of scheduled maintenance visits.',
      'Each line "DAY <date> <technicianId> (<name>)" is one technician-day, followed by its visits:',
      '"<stopId> <lat>,<lng> zone=<zone> <minutes on site> <address>".',
      '',
      'The office’s rules:',
      `- a day holds ${plan.minStopsPerDay} visits, and up to ${plan.maxStopsPerDay} where the next property is within 5 minutes’ drive;`,
      `- never more than ${plan.maxLegMinutes} minutes’ drive from one property on a day to the next;`,
      `- never more than ${Math.round(plan.maxOnSiteMinutes / 60)} hours on site in a day;`,
      '- a day with a move-out is built around it and holds 3 visits fewer for each;',
      '- the point is the least driving between properties. Driving from home does not count.',
      '',
      'Do two things.',
      '',
      '1. "notes": up to 6 short sentences naming the days that look wrong and why, in the office’s own terms',
      '   (neighbourhoods, freeways, the bay, the ship channel, a river). Example: "Wed 23 Dec mixes three visits on',
      '   I-10 East with six in north-west Houston". Say it plainly; no advice, no preamble.',
      '',
      '2. "moves": up to 25 single-visit moves that would shorten the driving, each to a day already in the list.',
      '   Only move a visit to a day whose properties are near it. Give the visit’s stopId exactly as written,',
      '   the target date, the target technicianId, and one short sentence of why.',
      '',
      'Answer with JSON only, exactly:',
      '{"notes":["..."],"moves":[{"stopId":"...","toDate":"YYYY-MM-DD","toTechnicianId":"...","why":"..."}]}',
      '',
      `The quarter (${described.shown} of ${days.length} days):`,
      described.text,
    ].join('\n');
  }

  /** One call, both answers, and never a throw the console cannot explain. */
  private async ask(
    configuration: ResolvedAiConfiguration,
    plan: { minStopsPerDay: number; maxStopsPerDay: number; maxOnSiteMinutes: number; maxLegMinutes: number },
    days: readonly PlanDay[],
  ): Promise<{ notes: string[]; moves: { stopId: string; toDate: string; toTechnicianId?: string | null; why?: string }[]; usage?: AiTokenUsage }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const prompt = this.prompt(plan, days);
      const response =
        configuration.provider === AiProvider.ANTHROPIC
          ? await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'content-type': 'application/json',
                'x-api-key': configuration.apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: configuration.modelId,
                max_tokens: 4_000,
                thinking: { type: 'disabled' },
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
              }),
            })
          : await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.apiKey}` },
              body: JSON.stringify({
                model: configuration.modelId,
                max_output_tokens: 4_000,
                input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
              }),
            });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok)
        throw new ApplicationError(
          502,
          'AI_PROVIDER_FAILED',
          `${configuration.provider === AiProvider.ANTHROPIC ? 'Anthropic' : 'OpenAI'} answered ${response.status}.`,
        );
      return this.parse(configuration.provider, payload);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.warn(`Plan advice failed (${configuration.provider}/${configuration.modelId}): ${String(error)}`);
      throw new ApplicationError(502, 'AI_PROVIDER_FAILED', 'The AI provider could not be reached. Try again.');
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The reply, read defensively: anything malformed is nothing, never a throw. */
  private parse(provider: AiProvider, payload: unknown) {
    const body = payload as
      | { content?: { text?: string }[]; output?: { content?: { text?: string }[] }[]; usage?: Record<string, number> }
      | null;
    const text =
      provider === AiProvider.ANTHROPIC
        ? (body?.content ?? []).map((block) => block.text ?? '').join('')
        : (body?.output ?? []).flatMap((item) => item.content ?? []).map((block) => block.text ?? '').join('');

    const usage = body?.usage
      ? {
          inputTokens: Number(body.usage.input_tokens ?? 0),
          outputTokens: Number(body.usage.output_tokens ?? 0),
          totalTokens: Number(body.usage.input_tokens ?? 0) + Number(body.usage.output_tokens ?? 0),
        }
      : undefined;

    const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return { notes: [], moves: [], usage };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return { notes: [], moves: [], usage };
    }

    const answer = parsed as { notes?: unknown; moves?: unknown };
    const notes = Array.isArray(answer.notes)
      ? answer.notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0).map((note) => note.trim().slice(0, 300)).slice(0, 8)
      : [];
    const moves = Array.isArray(answer.moves)
      ? answer.moves
          .filter(
            (move): move is { stopId: string; toDate: string; toTechnicianId?: string; why?: string } =>
              Boolean(move) &&
              typeof (move as { stopId?: unknown }).stopId === 'string' &&
              typeof (move as { toDate?: unknown }).toDate === 'string',
          )
          .map((move) => ({
            stopId: move.stopId,
            toDate: move.toDate.slice(0, 10),
            toTechnicianId: typeof move.toTechnicianId === 'string' ? move.toTechnicianId : null,
            why: typeof move.why === 'string' ? move.why : '',
          }))
      : [];
    return { notes, moves, usage };
  }
}
