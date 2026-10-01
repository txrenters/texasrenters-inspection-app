import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DriveTimeSource,
  InspectionStatus,
  InspectionType,
  JobberOutboundKind,
  PlanOriginKind,
  TbpPlanStatus,
  TbpStopStatus,
  UserRole,
} from '@prisma/client';
import {
  type AnchorSkipReason,
  type AssignedCrew,
  type DayAnchor,
  type DayLimits,
  type PlannableDay,
  type PlannableStop,
  type Quarter,
  type UnplacedReason,
  DEFAULT_DAY_LIMITS,
  MAX_LEG_MINUTES,
  MAX_STOPS_PER_DAY,
  anchorAsStop,
  anchorIdOf,
  byZoneNumber,
  crewKey,
  estimatedDriveMinutes,
  haversineMeters,
  layoutEveryDay,
  monthOfQuarter,
  planStartRange,
  plannedVisitDaysOfQuarter,
  quarterEnd,
  quarterFirstDay,
  quarterLabel,
  quarterStart,
  quarterWeekIndex,
  rescheduleMondaysOfQuarter,
  shortestOpenPathOrder,
  shortestRouteOrder,
  weekStartOf,
  weeklyZoneTechnicians,
  zoneNumberOf,
} from '@texasrenters/shared';

import { TechnicianSkillsService } from '../admin/technician-skills.service';
import { businessInstant, movedWindow } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { requestVisitPush } from '../integrations/jobber/jobber.outbound';
import { GoogleRoutesClient } from '../routing/google-routes.client';
import type { GeoPoint } from '../routing/osrm.client';
import { MapboxDirectionsClient } from '../routing/mapbox-directions.client';
import { BUILDING_POSITION_SELECT, propertyPosition } from '../admin/property-position';
import { OsrmClient } from '../routing/osrm.client';
import { activeTemplateId, templateForPlanning, type TemplateForPlanning } from './group-template.service';

/**
 * When a planned day starts, in Texas: the first job at nine.
 *
 * A quarter is planned months ahead, so Google needs a *when* as well as a
 * where -- a Tuesday morning and a Friday evening are different roads -- and
 * a Texas wall-clock time rather than a UTC hour, which would slide an hour
 * when daylight saving ends in November.
 */
const DAY_STARTS_AT = '09:00:00';

/**
 * How close, in seconds between the properties, a day's two driving orders
 * must be for the one that starts nearer home to win when the day is not
 * ordered from home itself (`orientTowardHome`).
 */
const HOME_END_TOLERANCE_SECONDS = 120;

/**
 * How long a move-out or move-in anchoring a day counts on site: an hour (the
 * office, 2026-09-17). It also takes the place of three of the day's visits
 * (`dayVisitRange`, 2026-09-18).
 */
const MOVE_ANCHOR_MINUTES = 60;

/** Block codes routing owns, cleared whenever the plan is routed again. */
const ROUTING_BLOCK_CODES = ['NO_COORDINATES', 'NOT_PLACED'];

/**
 * What a leg longer than the office allows between two properties adds when a
 * day's order is chosen: more than any day drives, so no order has one while
 * another way through the same properties does not (`dayOrder`).
 */
const OVER_LEG_SECONDS = 1_000_000;

/** The most technicians a plan can be built for: more than the office has. */
const MAX_PLAN_TECHNICIANS = 50;

/** The office's limits and visit lengths, as a coordinator may set them for a plan. */
export interface PlanRoutingSettings {
  occupiedVisitMinutes?: number;
  hvacVisitMinutes?: number;
  maxOnSiteMinutes?: number;
  /**
   * How far, by an estimated drive, a zone's middle may be from the nearest
   * crew member's home for the crew to work the zone (`zoneCircle`). Not a limit
   * on the day (the office, 2026-09-17).
   */
  maxDriveMinutes?: number;
  /**
   * Zones left out of this build, by number.
   *
   * The office works zones 1 to 4 and arranges zone 5 by hand. A stop in an
   * excluded zone is held back and marked as such rather than dropped: "we
   * left this for you" is a different thing from "this could not be placed".
   */
  excludedZones?: string[];
  /** The visits the planner groups into a day: nine (2026-09-19). */
  minStopsPerDay?: number;
  /** The most a day may hold, with the visits the office adds by hand: twelve. */
  maxStopsPerDay?: number;
  /**
   * The longest drive between two of a day's properties, in minutes: twenty
   * (2026-09-19). The drive from home is not held to it.
   */
  maxLegMinutes?: number;
  /**
   * Days the office is closed besides weekends and US federal holidays,
   * `YYYY-MM-DD`. Those are always left out; this is for any other day.
   */
  holidays?: string[];
  /**
   * The plan's first day, `YYYY-MM-DD`: up to fifteen days either side of the
   * quarter's first (2026-09-19). Null: the quarter's first day.
   */
  startsOn?: string | null;
  /**
   * Send this plan's visits to Jobber with nobody on them, so they arrive in
   * Jobber's Unassigned list for the office to hand out there.
   *
   * A setting on the plan rather than an argument to publish, because a visit
   * reaches Jobber long after the plan is published — the outbound queue drains
   * twenty-five every five minutes — and this is a fact about the plan.
   *
   * It changes nothing about who the visit belongs to *here*. The plan still
   * routes days per technician and the inspection still carries its assignment,
   * because that is what the phone and the console's calendar read.
   */
  jobberUnassigned?: boolean;
  /**
   * Who is sent out on the plan's days, chosen each time it is built
   * (2026-09-19). Empty: the benefit-package crew on the planning profiles.
   */
  technicianIds?: string[];
  /**
   * The office's group template the days are laid out from (2026-09-30), or
   * null for the planner's own grouping. Kept on the plan like the crew, so a
   * rebuild groups the same way until somebody chooses otherwise.
   */
  groupTemplateId?: string | null;
}

/** How a routing run is told what day it is: never a planned day before today. */
export interface RouteOptions {
  /** Today, `YYYY-MM-DD` in Texas. A draft is never laid out on a day already gone. */
  today?: string;

  /**
   * Lay out the visits that are already booked, rather than pinning them.
   *
   * Off by default, and that default is the safe one: a published stop is an
   * inspection and usually a Jobber visit, and moving one changes the day a
   * technician has been told to turn up. Routing therefore *measures* booked
   * days rather than rebuilding them.
   *
   * On, it is a real rebuild — the office asking for the whole quarter to be
   * grouped again because the first grouping was not good enough. Q4 2026 was
   * laid out at 6.5 visits a day across 55 days where the same visits pack
   * into 33 days of twelve for 4% more driving, and the only way to collect
   * that is to move visits that are already booked.
   *
   * What it will not move is in `movableInspection`: work that is done, being
   * reviewed, cancelled, or placed on a day by a person by hand.
   */
  movePublishedVisits?: boolean;

  /**
   * Who asked, for the audit on every visit a rebuild moves.
   *
   * Moving a booked visit changes the day a technician was told to turn up,
   * so the row that records it names a person. Null where the scheduler ran
   * it rather than somebody -- which cannot happen with
   * `movePublishedVisits`, because nothing sets both.
   */
  actorId?: string | null;
}

/**
 * Whether a booked visit may be moved by a rebuild.
 *
 * The line is drawn at whether anybody has acted on it yet. A scheduled visit
 * is a promise about a future day and a promise can be changed; a visit
 * somebody has walked, or is reviewing, or cancelled, is a record, and a
 * record is not the planner's to rewrite. `finalizedAt` is checked as well as
 * the status because it is the thing that freezes the evidence.
 */
export function movableInspection(inspection: {
  status: InspectionStatus;
  finalizedAt: Date | null;
}): boolean {
  return inspection.status === InspectionStatus.SCHEDULED && inspection.finalizedAt === null;
}

/** A booked visit as it stood before a rebuild, to compare against after. */
interface BookedVisit {
  inspectionId: string;
  /** `YYYY-MM-DD`, or null for a booked visit with no day yet. */
  date: string | null;
  technicianId: string | null;
}

export type RoutingUnplacedReason = UnplacedReason;

export interface RoutingSummary {
  planId: string;
  quarter: Quarter;
  placed: number;
  unplaced: { stopId: string; reason: RoutingUnplacedReason }[];
  capacity: { stops: number; onSiteMinutes: number; availableMinutes: number };
  days: number;
  durationSource: DriveTimeSource | null;
  settings: Required<PlanRoutingSettings>;
  /** Move-outs a day was built around. */
  anchored: number;
  /**
   * Move-outs no day was built around, and why: a weekend, a holiday or a Monday
   * kept free has no planned day; a day a coordinator took is theirs.
   */
  anchorsSkipped: { inspectionId: string; reason: AnchorSkipReason | 'NO_LOCATION' }[];
  /** The group template the days came from, and how much of the quarter it held; null for the planner's own grouping. */
  template: {
    id: string;
    name: string;
    revision: number;
    /** Days laid out from one of its groups. */
    days: number;
    /** Visits whose building is in no group of it -- new since it was saved -- placed by the planner. */
    notInTemplate: number;
    /** Visits move-out days gave up, put on the Monday after with the same person. */
    toMondays: number;
  } | null;
}

/** Who has which zone in each week of a plan's quarter, for the console. */
export interface PlanRotation {
  /** The benefit-package crew, in the order the zones go round. */
  crew: { technicianId: string; displayName: string | null; hasHome: boolean }[];
  /** The zones the crew goes round, in order. */
  zones: string[];
  /** Zones too far for a day's drive from every crew member's home: each is a trip. */
  outOfReach: string[];
  weeks: { weekOf: string; zones: { zone: string; technicianId: string }[] }[];
}

/** What a stop routing could not place says, on the stop. */
const UNPLACED_MESSAGE: Record<RoutingUnplacedReason, string> = {
  NO_WORKING_DAYS: 'The quarter has no days to plan this visit on.',
  NO_QUALIFIED_TECHNICIAN:
    'Nobody sent out on this plan can take this visit. Choose who goes out when you rebuild, or open this visit and give it a day and a technician yourself.',
  NO_CAPACITY:
    'Every crew member’s day in this visit’s month is already full. Rebuild with more technicians, or open this visit and give it a day and a technician yourself.',
  LONGER_THAN_A_DAY: 'This visit is longer than a whole day on site.',
  NO_TRIP_DAYS:
    'This zone is too far for a day’s drive, and no run of days in a row is free for a trip there, so the office needs to arrange these visits.',
};

/** A technician-day, measured on real roads where anything could measure it. */
interface MeasuredCrew {
  date: string;
  technicianId: string;
  /** The office's template group the day was laid out from; absent or null for one the planner grouped. */
  templateGroupId?: string | null;
  /** In driving order. */
  stops: PlannableStop[];
  /** Seconds from the stop before, per stop; null for the first, or when nothing measured it. */
  legSeconds: (number | null)[];
  /** Between the day's properties, first to last. */
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  /** Whether the day was routed from the technician's home. */
  fromHome: boolean;
  /** Home to the first property, when measured. */
  homeDriveSeconds: number | null;
  homeDriveMeters: number | null;
  durationSource: DriveTimeSource | null;
}

/** The matrix a day was measured with: the home first when the day has one (`homeIndex`). */
interface DayMatrix {
  durations: number[][];
  distances: number[][] | null;
  index: Map<string, number>;
  homeIndex: number | null;
}

/** The benefit-package crew, in the order the zones go round, and where each lives. */
export interface Roster {
  technicianIds: string[];
  homes: Map<string, GeoPoint>;
}

/**
 * The crew a quarter sent out to nobody is laid out with.
 *
 * The office, 2026-09-29: ticking "Send the visits out unassigned" means nobody
 * has the visits -- not in Jobber and not on a phone -- until the office hands
 * them out in Jobber. The planner still needs days, and a day is keyed to a crew
 * member (`TbpQuarterPlanDay.technicianId`), so the crew is kept as the number
 * of days that run at once and the zone each group takes in a week: groups, not
 * people. What it drops is where they live. A day nobody has been given does
 * not start at somebody's front door; it starts at its own first visit.
 */
export function forUnassigned(roster: Roster, unassigned: boolean): Roster {
  return unassigned ? { technicianIds: roster.technicianIds, homes: new Map() } : roster;
}

/**
 * What a quarter sent out to nobody calls its days: "Day group 1", "Day group 2",
 * in the crew's order, so the console never shows a person's name on a day that
 * person does not have. Any other id a stop carries -- a coordinator's pin from
 * before the box was ticked -- is numbered after them.
 */
export function dayGroupNames(crew: readonly string[], others: readonly string[] = []): Map<string, string> {
  const order = [...crew, ...[...new Set(others)].filter((id) => !crew.includes(id)).sort()];
  return new Map(order.map((id, index) => [id, `Day group ${index + 1}`]));
}

@Injectable()
export class QuarterPlannerService {
  private readonly logger = new Logger(QuarterPlannerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TechnicianSkillsService) private readonly skills: TechnicianSkillsService,
    @Inject(GoogleRoutesClient) private readonly google: GoogleRoutesClient,
    @Inject(OsrmClient) private readonly osrm: OsrmClient,
    @Inject(MapboxDirectionsClient) private readonly mapbox: MapboxDirectionsClient,
  ) {}

  /**
   * Give every stop in a draft a day, a technician and a place in the route.
   *
   * Separate from generation because it answers a different question and fails
   * for different reasons. Generation asks *who* is in the quarter and can only
   * be wrong about a tenancy; this asks *when and with whom*, and is wrong when
   * nobody is qualified, when the quarter has no room, or when routing is
   * unavailable. Splitting them means a coordinator can fix a blocked tenancy
   * and re-route without rebuilding the rotation underneath it.
   *
   * The office's rules (2026-09-19) hold for every day it writes:
   * - the crew the coordinator chose when building the plan, or the one set on
   *   the planning profiles, from the plan's first day -- up to fifteen days
   *   either side of the quarter's -- and never on a day already gone;
   * - the whole crew works every planned day from the plan's first until every
   *   visit has a day, in last quarter's order -- the month of the quarter a
   *   property was visited in orders it, it does not hold it back, and the days
   *   left at the end of the quarter stay empty (`layoutEveryDay`, 2026-09-20:
   *   "if they can finish it in a month then that's good");
   * - the visits are grouped into days of `minStopsPerDay`, nine, each as tight
   *   as the properties allow, and never more than `maxLegMinutes`, twenty, from
   *   one property to the next -- by the estimate as the days are laid out, and
   *   on Google's drives as each day is ordered;
   * - each has one zone a week, moving one zone on each week, and takes a group
   *   of it (`weeklyZoneTechnicians`); a property within five minutes of a
   *   group joins it whatever its zone;
   * - at most `maxOnSiteMinutes` inspecting;
   * - a zone too far for a day's drive from any home is a trip: back-to-back
   *   days of the crew member nearest it, the first driven from home and the
   *   rest from where the trip is;
   * - each day driven from the technician's home, in the order that drives least;
   * - a move-out anchors a day of the technician who handles move-outs, and a
   *   move-in the day of the crew member it is booked for: on its date their
   *   visits are the ones nearest it, from any zone, three fewer for each, and it
   *   is routed with them (`dayAnchors`);
   * - no planned visit on a Monday from the quarter's second week on, which is
   *   kept for rescheduled visits;
   * - a visit a coordinator placed by hand stays on the day and with the
   *   technician they chose, and is never moved.
   * Days are laid out on an estimate and then measured on real roads; a visit no
   * day can take is blocked with the reason.
   */
  async route(
    organizationId: string,
    planId: string,
    input: PlanRoutingSettings = {},
    options: RouteOptions = {},
  ): Promise<RoutingSummary> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: {
        id: true,
        status: true,
        quarterYear: true,
        quarterNumber: true,
        occupiedVisitMinutes: true,
        hvacVisitMinutes: true,
        maxOnSiteMinutes: true,
        maxDriveMinutes: true,
        minStopsPerDay: true,
        maxStopsPerDay: true,
        maxLegMinutes: true,
        holidays: true,
        excludedZones: true,
        startsOn: true,
        crewTechnicianIds: true,
        jobberUnassigned: true,
        groupTemplateId: true,
      },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    // A published stop is an inspection and a Jobber visit; moving it here
    // would only make the plan disagree with both. So routing only ever lays
    // out PLANNED stops, and a published quarter is routed again for the visits
    // it could not create (the office, 2026-09-20: "I should be able to rebuild
    // it"). A quarter mid-publish or cancelled is left alone.
    if (
      plan.status !== TbpPlanStatus.DRAFT &&
      plan.status !== TbpPlanStatus.PUBLISHED &&
      plan.status !== TbpPlanStatus.PUBLISH_FAILED
    )
      throw new ApplicationError(409, 'PLAN_NOT_DRAFT', 'Only a draft or published plan can be routed.');

    const quarter: Quarter = { year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] };
    const settings = routingSettings(planSettings(plan), input, quarter);
    // A crew chosen now is checked before anything is written.
    const roster = forUnassigned(
      await this.roster(organizationId, settings.technicianIds, input.technicianIds !== undefined),
      settings.jobberUnassigned,
    );
    // So is the template: a quarter is never quietly grouped some other way than the one chosen.
    const template = settings.groupTemplateId ? await this.groupTemplate(organizationId, settings.groupTemplateId) : null;
    await this.prisma.tbpQuarterPlan.update({
      where: { id: planId },
      data: { ...planColumns(settings), groupTemplateRevision: template?.revision ?? null },
    });

    // A visit a publish could not create -- no approved areas, no unit -- is
    // laid out again with the rest rather than staying failed forever.
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.FAILED, inspectionId: null },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });

    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.BLOCKED, blockedCode: { in: ROUTING_BLOCK_CODES } },
      data: { status: TbpStopStatus.PLANNED, blockedCode: null, blockedMessage: null },
    });
    for (const [inspectionType, minutes] of [
      [InspectionType.OCCUPIED, settings.occupiedVisitMinutes],
      [InspectionType.HVAC, settings.hvacVisitMinutes],
    ] as const)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        // A length a coordinator set is that visit's own, not its kind's.
        where: { planId, organizationId, inspectionType, onSiteMinutesOverriddenAt: null },
        data: { onSiteMinutes: minutes },
      });

    const { stops, pins, buildings } = await this.plannableStops(
      organizationId,
      planId,
      settings,
      options.movePublishedVisits,
    );
    /**
     * From a template, the template sets each day (the office, 2026-10-01), and
     * the dialog no longer asks how many visits a day. What the day size still
     * decides -- the days made from properties in none of its groups -- follows
     * the office's standing rule, nine and a tenth where it is close, whatever an
     * older console sends. The plan keeps its own size for its own grouping.
     */
    const daySize = template ? DEFAULT_DAY_LIMITS : settings;
    const limits: DayLimits = {
      maxOnSiteMinutes: settings.maxOnSiteMinutes,
      minStopsPerDay: daySize.minStopsPerDay,
      maxStopsPerDay: daySize.maxStopsPerDay,
      maxLegMinutes: settings.maxLegMinutes,
    };
    const zones = zoneCircle(stops, roster, settings.maxDriveMinutes);
    const days = await this.availability(
      organizationId,
      quarter,
      plannedVisitDaysOfQuarter(quarter, settings.holidays, settings.startsOn).filter(
        (date) => !options.today || date >= options.today,
      ),
      stops,
      roster,
      zones.circle,
      settings.startsOn,
    );
    const homes = await this.homesWith(organizationId, roster, pins);

    // Visits a coordinator placed by hand keep the days they make -- a Monday
    // kept for rescheduled visits, somebody off the crew -- measured beside the
    // planner's days, never moved or trimmed, and not given the planner's visits.
    const pinned = new Set(pins.keys());
    const free = stops.filter((stop) => !pinned.has(stop.stopId));
    const placedByHand = pinnedCrews(stops, pins);

    // In last quarter's order. A zone too far for a day's drive from any home is
    // a trip for the crew member living nearest it (the office, 2026-09-18).
    // A quarter sent out to nobody has day groups, not people: nobody's day can be
    // built around anybody's move-out until the office hands the days out in Jobber.
    const booked = settings.jobberUnassigned
      ? { anchors: [] as DayAnchor[], withoutLocation: [] as string[] }
      : await this.dayAnchors(organizationId, quarter, roster.technicianIds, settings.startsOn);
    const presets = template ? templateStops(template, free, buildings) : null;
    // From a template, a move-out day's trimmed visits go to the Monday after it (2026-10-01).
    const rescheduleMondays = presets
      ? await this.availability(
          organizationId,
          quarter,
          rescheduleMondaysOfQuarter(quarter, settings.holidays, settings.startsOn).filter(
            (date) => !options.today || date >= options.today,
          ),
          stops,
          roster,
          zones.circle,
          settings.startsOn,
        )
      : [];
    const assignment = layoutEveryDay(free, days, {
      limits,
      rotation: { position: new Map(stops.map((stop, index) => [stop.stopId, index])) },
      taken: new Set(placedByHand.map((crew) => crewKey(crew.date, crew.technicianId))),
      anchors: booked.anchors,
      homes: roster.homes,
      tripZones: zones.outOfReach,
      rescheduleMondays,
      quarter,
      ...(presets ? { presetGroups: presets.groups, presetTargets: presets.targets } : {}),
    });
    const unplaced: RoutingSummary['unplaced'] = assignment.unplaced;
    // A day's move-outs and move-ins are routed and measured with its visits,
    // as stops it drives to. A trip's later days start where the trip is, not at home.
    const measureCrew = (crew: Pick<AssignedCrew, 'date' | 'technicianId' | 'stops' | 'anchors' | 'trip'>) =>
      this.measure(
        { date: crew.date, technicianId: crew.technicianId, stops: [...(crew.anchors ?? []).map(anchorAsStop), ...crew.stops] },
        crew.trip && crew.trip.day > 1 ? undefined : homes.get(crew.technicianId),
        settings.maxLegMinutes * 60,
      );
    const measured: MeasuredCrew[] = [];
    for (const crew of assignment.crews)
      measured.push({
        ...(await measureCrew(crew)),
        // The office's group the day is, so it is shown in that group's name and colour.
        templateGroupId: crew.preset === undefined ? null : (template?.groups[crew.preset]?.id ?? null),
      });
    const byHand: MeasuredCrew[] = [];
    for (const crew of placedByHand) byHand.push(await measureCrew(crew));

    const crews = [...measured, ...byHand].sort(
      (left, right) => left.date.localeCompare(right.date) || left.technicianId.localeCompare(right.technicianId),
    );
    /**
     * Where each booked visit stood before the layout, so the change can be
     * found afterwards. Read only for a rebuild, and only for the visits a
     * rebuild is allowed to move.
     */
    const before = options.movePublishedVisits
      ? await this.bookedVisitDays(organizationId, planId)
      : new Map<string, BookedVisit>();

    await this.persist(organizationId, planId, crews, unplaced);

    // The inspections and Jobber visits behind the stops the layout moved.
    const moved = options.movePublishedVisits
      ? await this.rebookMovedVisits(organizationId, planId, before, options.actorId ?? null)
      : 0;
    if (moved) this.logger.log({ event: 'tbp_visits_rebooked', planId, moved });

    const summary: RoutingSummary = {
      planId,
      quarter,
      placed: crews.reduce((total, crew) => total + crew.stops.filter((stop) => anchorIdOf(stop) === null).length, 0),
      unplaced,
      capacity: assignment.capacity,
      days: crews.length,
      durationSource: crews.find((crew) => crew.durationSource !== null)?.durationSource ?? null,
      settings,
      anchored: assignment.crews.reduce((total, crew) => total + (crew.anchors?.length ?? 0), 0),
      anchorsSkipped: [
        ...booked.withoutLocation.map((inspectionId) => ({ inspectionId, reason: 'NO_LOCATION' as const })),
        ...assignment.skippedAnchors.map(({ anchorId, reason }) => ({ inspectionId: anchorId, reason })),
      ],
      template:
        template && presets
          ? {
              id: template.id,
              name: template.name,
              revision: template.revision,
              days: assignment.crews.filter((crew) => crew.preset !== undefined).length,
              notInTemplate: presets.notInTemplate,
              // Visits move-out days gave up, put on the Monday after.
              toMondays: assignment.crews
                .filter((crew) => crew.rescheduleMonday)
                .reduce((total, crew) => total + crew.stops.length, 0),
            }
          : null,
    };

    if (assignment.capacity.onSiteMinutes > assignment.capacity.availableMinutes)
      // Loudly, and before publish. Silently truncating a quarter would leave
      // tenancies uninspected with nothing anywhere saying which.
      this.logger.warn({
        event: 'tbp_plan_capacity_shortfall',
        quarter: quarterLabel(quarter),
        planId,
        onSiteMinutes: assignment.capacity.onSiteMinutes,
        availableMinutes: assignment.capacity.availableMinutes,
      });

    this.logger.log({
      event: 'tbp_plan_routed',
      organizationId,
      quarter: quarterLabel(quarter),
      planId,
      placed: summary.placed,
      unplaced: summary.unplaced.length,
      days: summary.days,
      anchored: summary.anchored,
      anchorsSkipped: summary.anchorsSkipped.length,
      crew: roster.technicianIds.length,
      crewChosen: settings.technicianIds.length > 0,
      startsOn: settings.startsOn ?? quarterFirstDay(quarter),
      plannedDays: days.length,
      zones: zones.circle,
      zonesOutOfReach: zones.outOfReach,
      tripDays: assignment.crews.filter((crew) => crew.trip).length,
      durationSource: summary.durationSource,
      groupTemplateId: summary.template?.id ?? null,
      templateDays: summary.template?.days ?? null,
      notInTemplate: summary.template?.notInTemplate ?? null,
    });

    return summary;
  }

  /**
   * Who has which zone in each week of a plan's quarter, for the console.
   *
   * Worked out as routing works it out -- the same crew, zones and reach -- so
   * the page shows the rotation the days were laid out with, as long as the
   * crew has not changed since. Reads only: it never blocks a stop.
   */
  /**
   * The names a quarter sent out to nobody shows instead of its crew's, or
   * null for a quarter whose days belong to people. See `dayGroupNames`.
   */
  async dayGroups(organizationId: string, planId: string, others: readonly string[] = []) {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { crewTechnicianIds: true, jobberUnassigned: true },
    });
    if (!plan?.jobberUnassigned) return null;
    const roster = await this.roster(organizationId, plan.crewTechnicianIds);
    return dayGroupNames(roster.technicianIds, others);
  }

  /**
   * A group template a quarter is to be laid out from, refused when there is
   * none by that id or it has been archived: the quarter is then built with
   * another grouping chosen, never quietly with the planner's own.
   */
  private async groupTemplate(organizationId: string, templateId: string): Promise<TemplateForPlanning> {
    const template = await templateForPlanning(this.prisma, organizationId, templateId);
    if (!template)
      throw new ApplicationError(422, 'GROUP_TEMPLATE_NOT_FOUND', 'That group template does not exist. Choose another grouping.');
    if (template.archivedAt)
      throw new ApplicationError(
        422,
        'GROUP_TEMPLATE_ARCHIVED',
        `The group template “${template.name}” has been archived. Choose another grouping to build this quarter.`,
      );
    return template;
  }

  /** The template the daily planner lays out a quarter it creates from: the active one, or none. */
  activeGroupTemplateId(organizationId: string): Promise<string | null> {
    return activeTemplateId(this.prisma, organizationId);
  }

  async rotation(organizationId: string, planId: string): Promise<PlanRotation> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: {
        quarterYear: true,
        quarterNumber: true,
        maxDriveMinutes: true,
        holidays: true,
        excludedZones: true,
        startsOn: true,
        crewTechnicianIds: true,
        jobberUnassigned: true,
      },
    });
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'This plan does not exist.');
    const quarter: Quarter = { year: plan.quarterYear, quarter: plan.quarterNumber as Quarter['quarter'] };

    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: { planId, organizationId, status: { not: TbpStopStatus.EXCLUDED } },
      select: {
        id: true,
        sequence: true,
        zone: true,
        inspectionType: true,
        propertywareBuilding: { select: BUILDING_POSITION_SELECT },
      },
    });
    const stops = withZones(
      rows.flatMap((row) =>
        !propertyPosition(row.propertywareBuilding)
          ? []
          : [
              {
                stopId: row.id,
                sequence: row.sequence,
                latitude: propertyPosition(row.propertywareBuilding)!.latitude,
                longitude: propertyPosition(row.propertywareBuilding)!.longitude,
                onSiteMinutes: 0,
                inspectionType: row.inspectionType,
                zone: zoneNumberOf(row.zone),
              },
            ],
      ),
    );
    const roster = forUnassigned(await this.roster(organizationId, plan.crewTechnicianIds), plan.jobberUnassigned);
    const zones = zoneCircle(stops, roster, plan.maxDriveMinutes);
    const startsOn = plan.startsOn ? isoDay(plan.startsOn) : null;
    const people = roster.technicianIds.length
      ? await this.prisma.userProfile.findMany({
          where: { id: { in: roster.technicianIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const names = new Map<string, string | null>(people.map((person) => [person.id, person.displayName]));
    // Nobody's days on a quarter sent out to nobody: see `dayGroupNames`.
    if (plan.jobberUnassigned) for (const [id, group] of dayGroupNames(roster.technicianIds)) names.set(id, group);

    const weeks = new Map<string, Record<string, string>>();
    for (const date of plannedVisitDaysOfQuarter(quarter, plan.holidays, startsOn)) {
      const weekOf = weekStartOf(date);
      if (!weeks.has(weekOf))
        weeks.set(weekOf, weeklyZoneTechnicians(roster.technicianIds, zones.circle, quarterWeekIndex(date, quarter, startsOn)));
    }

    return {
      crew: roster.technicianIds.map((technicianId) => ({
        technicianId,
        displayName: names.get(technicianId) ?? null,
        hasHome: roster.homes.has(technicianId),
      })),
      zones: zones.circle,
      outOfReach: zones.outOfReach,
      weeks: [...weeks.entries()].map(([weekOf, owners]) => ({
        weekOf,
        zones: Object.entries(owners)
          .map(([zone, technicianId]) => ({ zone, technicianId }))
          .sort((left, right) => byZoneNumber(left.zone, right.zone)),
      })),
    };
  }

  /**
   * Measure some technician-days again, from the visits on them now.
   *
   * For a coordinator's change to a draft: a visit moved to another day or
   * technician leaves one day and joins another, and a new visit length changes
   * a day's time inspecting. Each day is ordered from the technician's home and
   * measured on real roads, as routing measures one, and written back; a day
   * left with no visit goes. Nothing is refused for leaving a day short or long:
   * the day shows it, for the coordinator to see and decide.
   */
  async measureDays(
    organizationId: string,
    planId: string,
    days: readonly { date: string; technicianId: string }[],
  ): Promise<void> {
    const plan = await this.prisma.tbpQuarterPlan.findFirst({
      where: { id: planId, organizationId },
      select: { maxLegMinutes: true },
    });
    const maxLegSeconds = (plan?.maxLegMinutes ?? MAX_LEG_MINUTES) * 60;
    const unique = new Map(days.map((day) => [crewKey(day.date, day.technicianId), day]));
    for (const { date, technicianId } of unique.values()) {
      const on = new Date(`${date}T00:00:00.000Z`);
      const rows = await this.prisma.tbpQuarterPlanStop.findMany({
        where: { planId, organizationId, status: TbpStopStatus.PLANNED, scheduledOn: on, assignedTechnicianId: technicianId },
        select: {
          id: true,
          sequence: true,
          zone: true,
          inspectionType: true,
          onSiteMinutes: true,
          propertywareBuilding: { select: BUILDING_POSITION_SELECT },
        },
        orderBy: { sequence: 'asc' },
      });
      const stops: PlannableStop[] = rows.flatMap((row) =>
        !propertyPosition(row.propertywareBuilding)
          ? []
          : [
              {
                stopId: row.id,
                sequence: row.sequence,
                latitude: propertyPosition(row.propertywareBuilding)!.latitude,
                longitude: propertyPosition(row.propertywareBuilding)!.longitude,
                inspectionType: row.inspectionType,
                onSiteMinutes: row.onSiteMinutes ?? 0,
                zone: zoneNumberOf(row.zone),
              },
            ],
      );

      // The move-outs and move-ins the day is built around are still its stops.
      const anchors = (
        await this.prisma.tbpQuarterPlanAnchor.findMany({
          where: { planId, organizationId, technicianId, date: on },
          select: {
            inspectionId: true,
            onSiteMinutes: true,
            inspection: {
              select: { inspectionType: true, propertywareBuilding: { select: BUILDING_POSITION_SELECT } },
            },
          },
        })
      ).flatMap((row) => {
        const building = row.inspection.propertywareBuilding;
        return !propertyPosition(building)
          ? []
          : [
              anchorAsStop({
                id: row.inspectionId,
                date,
                technicianId,
                latitude: propertyPosition(building)!.latitude,
                longitude: propertyPosition(building)!.longitude,
                onSiteMinutes: row.onSiteMinutes,
                kind: row.inspection.inspectionType === InspectionType.MOVE_IN ? 'MOVE_IN' : 'MOVE_OUT',
              }),
            ];
      });

      if (stops.length === 0 && anchors.length === 0) {
        await this.prisma.tbpQuarterPlanDay.deleteMany({ where: { planId, organizationId, technicianId, date: on } });
        continue;
      }

      const crew = await this.measure(
        { date, technicianId, stops: [...anchors, ...stops] },
        await this.homeOf(organizationId, technicianId),
        maxLegSeconds,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.tbpQuarterPlanDay.upsert({
          where: { planId_technicianId_date: { planId, technicianId, date: on } },
          create: { organizationId, planId, technicianId, date: on, ...dayRow(crew) },
          update: { ...dayRow(crew), computedAt: new Date() },
        });
        for (const [index, stop] of crew.stops.entries()) {
          const data = { positionInDay: index + 1, driveSecondsForecast: whole(crew.legSeconds[index] ?? null) };
          const anchorId = anchorIdOf(stop);
          if (anchorId) await tx.tbpQuarterPlanAnchor.updateMany({ where: { planId, inspectionId: anchorId }, data });
          else await tx.tbpQuarterPlanStop.update({ where: { id: stop.stopId }, data });
        }
      });
    }
  }

  /**
   * The move-outs and move-ins the quarter's days are built around.
   *
   * Every move-out and move-in booked inside the quarter and not cancelled
   * anchors the day of the crew member it is assigned to; one assigned to
   * nobody, or to somebody off the crew, is not the plan's (move-ins 2026-09-18,
   * move-outs 2026-10-01 -- see below). One whose building has no coordinates
   * has nowhere to gather visits round, so it is reported instead. From the
   * plan's first day: a plan started before its quarter is built around the
   * move-outs on those days too.
   */
  private async dayAnchors(
    organizationId: string,
    quarter: Quarter,
    crew: readonly string[],
    startsOn: string | null,
  ): Promise<{ anchors: DayAnchor[]; withoutLocation: string[] }> {
    const booked = await this.prisma.inspection.findMany({
      where: {
        organizationId,
        inspectionType: { in: [InspectionType.MOVE_OUT, InspectionType.MOVE_IN] },
        status: { not: InspectionStatus.CANCELLED },
        scheduledAt: { gte: startsOn ? new Date(`${startsOn}T00:00:00.000Z`) : quarterStart(quarter), lt: quarterEnd(quarter) },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true,
        inspectionType: true,
        scheduledAt: true,
        propertywareBuilding: { select: BUILDING_POSITION_SELECT },
        assignments: { where: { isCurrent: true }, select: { technicianId: true }, take: 1 },
      },
    });
    const anchors: DayAnchor[] = [];
    const withoutLocation: string[] = [];
    for (const inspection of booked) {
      const moveIn = inspection.inspectionType === InspectionType.MOVE_IN;
      /**
       * On the day of whoever it is assigned to, move-out and move-in alike.
       *
       * Move-outs used to go on the day of the one technician marked as handling
       * them. Production said otherwise (2026-10-01): of 48 weekday move-outs in
       * Q3 and Q4 2026, 14 were the benefit-package crew's, and most were
       * Beatriz's and Amy's, who are not on it -- so his days were trimmed for
       * work he was not doing. One assigned to nobody, or to somebody off the
       * crew, takes nobody's day.
       */
      const assigned = inspection.assignments[0]?.technicianId ?? null;
      const technicianId = assigned && crew.includes(assigned) ? assigned : null;
      if (!technicianId) continue;
      const building = inspection.propertywareBuilding;
      if (!propertyPosition(building)) {
        withoutLocation.push(inspection.id);
        continue;
      }
      anchors.push({
        id: inspection.id,
        date: inspection.scheduledAt.toISOString().slice(0, 10),
        technicianId,
        latitude: propertyPosition(building)!.latitude,
        longitude: propertyPosition(building)!.longitude,
        onSiteMinutes: MOVE_ANCHOR_MINUTES,
        kind: moveIn ? 'MOVE_IN' : 'MOVE_OUT',
      });
    }
    return { anchors, withoutLocation };
  }

  /**
   * The stops that can be placed at all, with each visit's length and zone.
   *
   * A stop whose building never geocoded has no coordinates, so no day can be
   * chosen for it on any sensible basis. It is marked rather than dropped —
   * `NO_COORDINATES` on the stop is what turns "this tenancy vanished" into
   * "this address needs geocoding", which is a thing somebody can act on.
   */
  private async plannableStops(
    organizationId: string,
    planId: string,
    settings: Required<PlanRoutingSettings>,
    movePublishedVisits = false,
  ) {
    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      // A published visit is read too, and pinned below. Left out, its day is
      // invisible here: the planner lays fresh visits over a day that is
      // already booked, and the day's own row counts only the new ones -- the
      // office saw "1 visit" on a day the map drew eleven (2026-09-20).
      where: { planId, organizationId, status: { in: [TbpStopStatus.PLANNED, TbpStopStatus.PUBLISHED] } },
      select: {
        id: true,
        sequence: true,
        zone: true,
        inspectionId: true,
        inspectionType: true,
        previousTechnicianId: true,
        previousVisitOn: true,
        previousVisitMonth: true,
        scheduledOn: true,
        assignedTechnicianId: true,
        scheduleOverriddenAt: true,
        technicianOverriddenAt: true,
        onSiteMinutes: true,
        onSiteMinutesOverriddenAt: true,
        // Which property it is, for a quarter laid out from a group template.
        propertywareBuildingId: true,
        propertywareBuilding: { select: BUILDING_POSITION_SELECT },
        // Only read for a rebuild, and it decides whether a booked visit is
        // still the planner's to move: see `movableInspection`.
        inspection: { select: { status: true, finalizedAt: true } },
      },
      orderBy: { sequence: 'asc' },
    });

    const stops: PlannableStop[] = [];
    /** Each stop's building: what a group template names. */
    const buildings = new Map<string, string>();
    // Placed by hand: a coordinator chose both the day and the technician.
    const pins = new Map<string, Pin>();
    const unplaceable: string[] = [];
    /**
     * Zones the office asked to leave out of this build.
     *
     * Held back rather than dropped: a stop in an excluded zone is marked so
     * the quarter says out loud that it was left for the office to arrange,
     * which is a different thing from a visit the planner could not place.
     */
    const excludedZones = new Set(
      (settings.excludedZones ?? []).map((zone) => zoneNumberOf(zone)).filter(Boolean),
    );
    const excluded: string[] = [];
    for (const row of rows) {
      if (excludedZones.size && excludedZones.has(zoneNumberOf(row.zone))) {
        excluded.push(row.id);
        continue;
      }
      // Where the office says it is: the corrected centre when there is one, the
      // geocode otherwise -- the same answer the maps draw it at.
      const at = propertyPosition(row.propertywareBuilding);
      if (!at) {
        unplaceable.push(row.id);
        continue;
      }
      /**
       * Placed by a coordinator, or already an inspection somebody is being
       * sent to: either way the day and the technician are decided, and routing
       * measures the day rather than laying it out again.
       *
       * On a rebuild the second of those stops holding. The office has asked
       * for the quarter to be grouped again, and a booked visit nobody has
       * acted on yet is exactly what has to move for that to mean anything --
       * so an inspection only pins its stop while it is past the point of
       * being moved. A coordinator's own choice pins either way: that is a
       * person's decision about a particular visit, not the planner's.
       */
      const booked = movePublishedVisits
        ? Boolean(row.inspection && !movableInspection(row.inspection))
        : Boolean(row.inspectionId);
      const settled = booked || Boolean(row.scheduleOverriddenAt && row.technicianOverriddenAt);
      if (settled && row.scheduledOn && row.assignedTechnicianId)
        pins.set(row.id, { date: row.scheduledOn.toISOString().slice(0, 10), technicianId: row.assignedTechnicianId });
      if (row.propertywareBuildingId) buildings.set(row.id, row.propertywareBuildingId);
      stops.push({
        stopId: row.id,
        sequence: row.sequence,
        latitude: at.latitude,
        longitude: at.longitude,
        inspectionType: row.inspectionType ?? InspectionType.OCCUPIED,
        onSiteMinutes:
          row.onSiteMinutesOverriddenAt && row.onSiteMinutes !== null && row.onSiteMinutes !== undefined
            ? row.onSiteMinutes
            : row.inspectionType === InspectionType.HVAC
              ? settings.hvacVisitMinutes
              : settings.occupiedVisitMinutes,
        previousTechnicianId: row.previousTechnicianId ?? null,
        zone: zoneNumberOf(row.zone),
        // The month of the quarter its last visit was in, which this one keeps: as
        // generation recorded it, or read from the day for a stop from before.
        ...(row.previousVisitMonth
          ? { month: row.previousVisitMonth }
          : row.previousVisitOn
            ? { month: monthOfQuarter(isoDay(row.previousVisitOn)) }
            : {}),
      });
    }

    if (unplaceable.length > 0)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: unplaceable } },
        data: {
          status: TbpStopStatus.BLOCKED,
          blockedCode: 'NO_COORDINATES',
          blockedMessage: 'This property has not been geocoded, so it cannot be routed.',
        },
      });

    if (excluded.length > 0)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: excluded } },
        data: {
          status: TbpStopStatus.BLOCKED,
          blockedCode: 'ZONE_EXCLUDED',
          blockedMessage: 'This zone was left out of the build, so the office arranges these visits.',
        },
      });

    return { stops: withZones(stops), pins, buildings };
  }

  /**
   * The benefit-package crew, in the order the zones go round, and where each lives.
   *
   * The technicians the coordinator chose when building the plan (the office,
   * 2026-09-19: "before generating ... it should ask for the technicians"), in
   * the crew's order and then by name. A chosen technician who has left since is
   * dropped; one chosen now who is not an active technician is refused
   * (`strict`), before anything is written.
   *
   * Nobody chosen: the crew set on the technicians' planning profiles by their
   * place in the rotation (`tbpZoneOrder`) -- Moses, Kevin and Emanuel,
   * 2026-09-16 -- and nobody else, however plannable. A profile marked
   * unplannable is left out even with a place: somebody on leave keeps it for
   * when they are back.
   *
   * The home is where each day's route starts. The drive from it is shown, and
   * not counted against the day's limits.
   */
  private async roster(organizationId: string, chosen: readonly string[] = [], strict = false): Promise<Roster> {
    if (chosen.length) return this.chosenRoster(organizationId, chosen, strict);
    const profiles = await this.prisma.technicianPlanningProfile.findMany({
      where: { organizationId, isPlannable: true, tbpZoneOrder: { not: null } },
      orderBy: [{ tbpZoneOrder: 'asc' }, { technicianId: 'asc' }],
      select: { technicianId: true, homeLatitude: true, homeLongitude: true },
    });
    const homes = new Map<string, GeoPoint>();
    for (const row of profiles)
      if (row.homeLatitude != null && row.homeLongitude != null)
        homes.set(row.technicianId, { latitude: Number(row.homeLatitude), longitude: Number(row.homeLongitude) });
    return { technicianIds: profiles.map((row) => row.technicianId), homes };
  }

  /** The technicians a coordinator chose for a plan, as a crew: see `roster`. */
  private async chosenRoster(organizationId: string, chosen: readonly string[], strict: boolean): Promise<Roster> {
    const ids = [...new Set(chosen)];
    const [people, profiles] = await Promise.all([
      this.prisma.userProfile.findMany({
        where: {
          id: { in: ids },
          isActive: true,
          memberships: { some: { organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        },
        select: { id: true, displayName: true },
      }),
      this.prisma.technicianPlanningProfile.findMany({
        where: { organizationId, technicianId: { in: ids } },
        select: { technicianId: true, tbpZoneOrder: true, homeLatitude: true, homeLongitude: true },
      }),
    ]);
    if (strict && people.length !== ids.length)
      throw new ApplicationError(422, 'NOT_A_TECHNICIAN', 'Choose active technicians to send out on the plan.');
    const profileOf = new Map(profiles.map((row) => [row.technicianId, row]));
    const order = (technicianId: string) => profileOf.get(technicianId)?.tbpZoneOrder ?? Number.POSITIVE_INFINITY;
    const ordered = [...people].sort(
      (left, right) => order(left.id) - order(right.id) || (left.displayName ?? '').localeCompare(right.displayName ?? ''),
    );
    const homes = new Map<string, GeoPoint>();
    for (const row of profiles)
      if (row.homeLatitude != null && row.homeLongitude != null)
        homes.set(row.technicianId, { latitude: Number(row.homeLatitude), longitude: Number(row.homeLongitude) });
    return { technicianIds: ordered.map((person) => person.id), homes };
  }

  /**
   * The crew's homes, and the home of anyone else a coordinator placed a visit
   * with: somebody off the crew covering a day still drives from their own.
   */
  private async homesWith(organizationId: string, roster: Roster, pins: ReadonlyMap<string, Pin>) {
    const others = [...new Set([...pins.values()].map((pin) => pin.technicianId))].filter(
      (technicianId) => !roster.technicianIds.includes(technicianId),
    );
    if (others.length === 0) return roster.homes;
    const profiles = await this.prisma.technicianPlanningProfile.findMany({
      where: { organizationId, technicianId: { in: others } },
      select: { technicianId: true, homeLatitude: true, homeLongitude: true },
    });
    const homes = new Map(roster.homes);
    for (const row of profiles)
      if (row.homeLatitude != null && row.homeLongitude != null)
        homes.set(row.technicianId, { latitude: Number(row.homeLatitude), longitude: Number(row.homeLongitude) });
    return homes;
  }

  /** Where a technician's day starts, when a home is on file: anyone's, not only the crew's. */
  private async homeOf(organizationId: string, technicianId: string): Promise<GeoPoint | undefined> {
    const profile = await this.prisma.technicianPlanningProfile.findFirst({
      where: { organizationId, technicianId },
      select: { homeLatitude: true, homeLongitude: true },
    });
    return profile?.homeLatitude != null && profile.homeLongitude != null
      ? { latitude: Number(profile.homeLatitude), longitude: Number(profile.homeLongitude) }
      : undefined;
  }

  /**
   * Who can work each planned day, per zone and kind of visit.
   *
   * The whole crew works every planned day (the office, 2026-09-18). Each day's
   * zones come from the week it falls in -- the crew each has one zone, and all
   * move one zone on each week -- and say where each starts, not who works.
   * Qualification still applies on top, per date and per kind of visit, because
   * a certificate lapsing mid-quarter must take away the later days and leave
   * the earlier ones alone.
   */
  private async availability(
    organizationId: string,
    quarter: Quarter,
    dates: readonly string[],
    stops: readonly PlannableStop[],
    roster: Roster,
    circle: readonly string[],
    startsOn: string | null,
  ): Promise<PlannableDay[]> {
    const types = [...new Set(stops.map((stop) => stop.inspectionType as InspectionType))];
    const asDates = dates.map((date) => new Date(`${date}T00:00:00.000Z`));
    const calendars = new Map<InspectionType, Awaited<ReturnType<TechnicianSkillsService['qualificationCalendar']>>>();
    for (const type of types) calendars.set(type, await this.skills.qualificationCalendar(organizationId, type, asDates));

    return dates.map((date) => {
      const zoneTechnicians = circle.length
        ? weeklyZoneTechnicians(roster.technicianIds, circle, quarterWeekIndex(date, quarter, startsOn))
        : undefined;
      const working = [...roster.technicianIds];
      const qualified: Record<string, string[]> = {};
      for (const [type, calendar] of calendars) {
        const onCalendar = new Set((calendar.get(date) ?? []).map((candidate) => candidate.technicianId));
        qualified[type] = working.filter((technicianId) => onCalendar.has(technicianId));
      }
      return { date, technicianIds: working, qualified, ...(zoneTechnicians ? { zoneTechnicians } : {}) };
    });
  }

  /**
   * Order one technician-day and measure its drives.
   *
   * Google first, OSRM second, straight-line last. The fallbacks are ordered by
   * how much they can honestly claim: traffic-aware seconds, free-flow seconds,
   * and then a distance with no time attached at all — because a made-up
   * duration is worse than an absent one, and a plan that says "five hours"
   * when it means "we did not measure" is how somebody ends up late.
   *
   * One matrix of the technician's home and the day's stops. The day is routed
   * from home, in the order that drives least in all with no drive between two
   * properties longer than `maxLegSeconds` where any order manages that
   * (`dayOrder`). Without a home on file the matrix is the stops alone and the
   * day starts at its first job.
   */
  private async measure(
    crew: Pick<AssignedCrew, 'date' | 'technicianId' | 'stops'>,
    home: GeoPoint | undefined,
    maxLegSeconds?: number,
  ): Promise<MeasuredCrew> {
    const stops = [...crew.stops];
    const base = { date: crew.date, technicianId: crew.technicianId, fromHome: Boolean(home) };
    if (stops.length === 0 || (stops.length === 1 && !home))
      // Nothing to drive between, which is a true zero rather than an unknown.
      return {
        ...base,
        stops,
        legSeconds: stops.map(() => null),
        totalDriveSeconds: 0,
        totalDriveMeters: 0,
        homeDriveSeconds: null,
        homeDriveMeters: null,
        durationSource: null,
      };

    // The home first, so row and column zero are the drives from and to it.
    const points: GeoPoint[] = home ? [home, ...stops] : stops;
    const offset = home ? 1 : 0;
    /**
     * Mapbox measures the day, and it needs no flag to turn it on.
     *
     * The office asked for drive times worked out from the road rather than
     * from live traffic, and this is exactly that: `driving` rather than
     * `driving-traffic`, so the road at its speed limits and not whatever the
     * afternoon of the build happened to look like. A quarter rebuilt twice
     * comes back the same, which a traffic-aware one does not.
     *
     * It also needs no billing relationship beyond the one already paying for
     * the maps. That is what made the straight-line estimate the ordinary path
     * here in the first place: Google's account lapsed and took every drive
     * time with it, and a quarter that cannot be rebuilt is worse than one
     * measured a few per cent out.
     *
     * `PLANNING_ROAD_DRIVE_TIMES=true` still puts Google's traffic-aware times
     * in front, for a quarter somebody wants measured against a real morning.
     */
    const mapbox = await this.mapbox.matrix(points);
    const roadTimes = process.env.PLANNING_ROAD_DRIVE_TIMES === 'true';
    const google =
      mapbox || !roadTimes
        ? null
        : await this.google.matrix(points, businessInstant(crew.date, DAY_STARTS_AT));
    const measured = mapbox ?? google;
    const durations =
      measured?.durations ?? (roadTimes ? await this.osrm.durations(points) : null);
    if (durations) {
      const matrix: DayMatrix = {
        durations,
        distances: measured?.distances ?? null,
        index: new Map(stops.map((stop, position) => [stop.stopId, position + offset])),
        homeIndex: home ? 0 : null,
      };
      return {
        ...base,
        ...inMatrixOrder(stops, matrix, home, maxLegSeconds),
        durationSource: google
          ? DriveTimeSource.GOOGLE_TRAFFIC_AWARE
          : mapbox
            ? DriveTimeSource.MAPBOX_FREE_FLOW
            : DriveTimeSource.OSRM_FREE_FLOW,
      };
    }

    /**
     * Straight-line, and now with seconds on it.
     *
     * This used to return the distance and no time at all -- honest, and
     * useless: a day with no drive time is a day the console cannot show, the
     * capacity check cannot weigh and the office cannot compare. It was the
     * fallback for an outage, so nobody minded; it is the ordinary path now,
     * and a plan with no times would be no plan.
     *
     * The seconds come from `estimatedDriveMinutes`, which is the same
     * function that laid the day out. That is deliberate: measuring with a
     * different rule than the one that chose the grouping is how a day comes
     * back over its own limit the moment it is measured.
     */
    const metres = points.map((from) => points.map((to) => haversineMeters(from, to)));
    const seconds = (from: GeoPoint, to: GeoPoint) => Math.round(estimatedDriveMinutes(from, to) * 60);
    const between = stops.map((_, from) => stops.map((__, to) => metres[from + offset]![to + offset]!));
    const order = dayOrder(between, home ? stops.map((_, to) => metres[0]![to + offset]!) : null, stops, home);
    const homeLeg = home && order.length ? metres[0]![order[0]! + offset]! : null;
    const ordered = order.map((index) => stops[index]!);
    // The first stop's leg is the drive from home, which is not counted
    // against the day -- the same rule the road-time path follows.
    const legs = ordered.map((stop, position) =>
      position === 0 ? null : seconds(ordered[position - 1]!, stop),
    );
    return {
      ...base,
      stops: ordered,
      legSeconds: legs,
      totalDriveSeconds: legs.reduce((sum: number, leg) => sum + (leg ?? 0), 0),
      totalDriveMeters: pathCost(between, order),
      homeDriveSeconds: home && ordered.length ? seconds(home, ordered[0]!) : null,
      homeDriveMeters: homeLeg,
      durationSource: DriveTimeSource.HAVERSINE,
    };
  }

  /**
   * Where every movable booked visit stands right now.
   *
   * Taken before the layout so the rebuild can tell which visits it actually
   * moved. Comparing afterwards rather than trusting the layout's own output
   * keeps this honest about one thing in particular: a visit the layout put
   * back on the day it was already on must not be reported to Jobber as a
   * reschedule, because nothing about it changed.
   */
  private async bookedVisitDays(organizationId: string, planId: string) {
    const rows = await this.prisma.tbpQuarterPlanStop.findMany({
      where: {
        planId,
        organizationId,
        status: TbpStopStatus.PUBLISHED,
        inspectionId: { not: null },
        // A day a person chose is theirs; a rebuild never touches it, so it is
        // not read here either.
        scheduleOverriddenAt: null,
      },
      select: {
        id: true,
        inspectionId: true,
        scheduledOn: true,
        assignedTechnicianId: true,
        inspection: { select: { status: true, finalizedAt: true } },
      },
    });
    const before = new Map<string, BookedVisit>();
    for (const row of rows)
      if (row.inspection && movableInspection(row.inspection) && row.inspectionId)
        before.set(row.id, {
          inspectionId: row.inspectionId,
          date: row.scheduledOn?.toISOString().slice(0, 10) ?? null,
          technicianId: row.assignedTechnicianId,
        });
    return before;
  }

  /**
   * Move the inspection and the Jobber visit behind every stop the layout moved.
   *
   * The office's rule, in their words: the visit is not deleted and made
   * again, its day is changed. So the inspection keeps its id, its evidence,
   * its Jobber visit and its place in any comparison -- only its day moves,
   * with any clock-time window on it, and Jobber is told through the same
   * reschedule path the console uses when somebody changes one visit by hand.
   *
   * A technician change is a second thing and is sent as one: Jobber's visit
   * and its assignment are separate, and a reschedule that silently reassigned
   * would leave the old technician's calendar wrong.
   *
   * On a plan the office chose to publish unassigned, there is no technician
   * half. Its days are groups, not people (the office, 2026-09-29: nobody has
   * them until they are handed out in Jobber), so a visit moving from one group
   * to another changes nobody's work -- here or in Jobber. Whoever the office
   * gave it to in Jobber keeps it.
   */
  private async rebookMovedVisits(
    organizationId: string,
    planId: string,
    before: ReadonlyMap<string, BookedVisit>,
    actorId: string | null,
  ) {
    if (!before.size) return 0;
    const [plan, after] = await Promise.all([
      this.prisma.tbpQuarterPlan.findUnique({
        where: { id: planId },
        select: { jobberUnassigned: true },
      }),
      this.prisma.tbpQuarterPlanStop.findMany({
        where: { id: { in: [...before.keys()] } },
        select: { id: true, scheduledOn: true, assignedTechnicianId: true },
      }),
    ]);

    const pushEdits = getJobberConfig().pushEditsEnabled;
    let moved = 0;
    for (const row of after) {
      const was = before.get(row.id);
      if (!was) continue;
      const date = row.scheduledOn?.toISOString().slice(0, 10) ?? null;
      // A stop the layout could not place keeps its booking rather than losing
      // a day it already has: an unplaced visit is a problem to look at, not a
      // reason to strand a technician's calendar entry.
      if (!date || !row.assignedTechnicianId) continue;
      const dayMoved = date !== was.date;
      const technicianChanged = !plan?.jobberUnassigned && row.assignedTechnicianId !== was.technicianId;
      if (!dayMoved && !technicianChanged) continue;

      await this.prisma.$transaction(async (tx) => {
        if (dayMoved) {
          /**
           * A visit the office gave a clock time in Jobber keeps it on its new
           * day. The push sends a timed visit by its window, not its day, so a
           * window left behind sent the visit back to the day it already had,
           * and the next sync then moved the inspection back to match.
           */
          const window = await tx.inspection.findUnique({
            where: { id: was.inspectionId },
            select: { scheduledStartAt: true, scheduledEndAt: true },
          });
          await tx.inspection.update({
            where: { id: was.inspectionId },
            data: { scheduledAt: row.scheduledOn!, ...(window ? movedWindow(window, date) : {}) },
          });
        }

        if (technicianChanged) {
          // The old assignment is ended rather than edited, so the record says
          // who was going to go and who is going now.
          await tx.inspectionAssignment.updateMany({
            where: { inspectionId: was.inspectionId, isCurrent: true },
            data: {
              isCurrent: false,
              status: 'UNASSIGNED',
              endedAt: new Date(),
              endedById: actorId,
              reason: 'The quarter was grouped again.',
            },
          });
          await tx.inspectionAssignment.create({
            data: {
              inspectionId: was.inspectionId,
              technicianId: row.assignedTechnicianId!,
              assignedById: actorId,
              isCurrent: true,
            },
          });
        }

        // `requestVisitPush` is a no-op for a visit that never reached Jobber.
        // It is not one while pushes are switched off, which is why the switch
        // is read here as the console reads it: a move queued then is never
        // sent, and it held Jobber's own later moves back for good -- three of
        // Moses's October 1 stops that Jobber no longer had there (2026-10-01).
        // With the switch off, Jobber's day is the one both keep.
        if (pushEdits && dayMoved)
          await requestVisitPush(tx, {
            organizationId,
            inspectionId: was.inspectionId,
            kind: JobberOutboundKind.VISIT_RESCHEDULE,
            requestedById: actorId,
          });
        if (pushEdits && technicianChanged)
          await requestVisitPush(tx, {
            organizationId,
            inspectionId: was.inspectionId,
            kind: JobberOutboundKind.VISIT_ASSIGN,
            requestedById: actorId,
          });

        await tx.auditLog.create({
          data: {
            organizationId,
            actorUserId: actorId,
            actorApiClientId: null,
            action: 'TBP_VISIT_REBOOKED',
            entityType: 'Inspection',
            entityId: was.inspectionId,
            // The days, so a technician asking why their week changed can be
            // told what it was and what it became.
            metadata: {
              planId,
              from: was.date,
              to: date,
              technicianChanged,
            },
          },
        });
      });
      moved += 1;
    }
    return moved;
  }

  private async persist(
    organizationId: string,
    planId: string,
    crews: readonly MeasuredCrew[],
    unplaced: RoutingSummary['unplaced'],
  ) {
    // Cleared first, so a re-route never leaves a day from the previous run
    // sitting beside the new ones and doubling the forecast -- and so a stop
    // this run could not place does not keep the day the last run gave it,
    // which publish would otherwise book.
    await this.prisma.tbpQuarterPlanDay.deleteMany({ where: { planId } });
    await this.prisma.tbpQuarterPlanAnchor.deleteMany({ where: { planId } });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED },
      data: { positionInDay: null, driveSecondsForecast: null },
    });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED, scheduleOverriddenAt: null },
      data: { scheduledOn: null },
    });
    await this.prisma.tbpQuarterPlanStop.updateMany({
      where: { planId, organizationId, status: TbpStopStatus.PLANNED, technicianOverriddenAt: null },
      data: { assignedTechnicianId: null },
    });

    for (const batch of chunk(crews, 10)) {
      await this.prisma.$transaction(async (tx) => {
        for (const crew of batch) {
          await tx.tbpQuarterPlanDay.create({
            data: {
              organizationId,
              planId,
              technicianId: crew.technicianId,
              date: new Date(`${crew.date}T00:00:00.000Z`),
              ...dayRow(crew),
              templateGroupId: crew.templateGroupId ?? null,
            },
          });

          for (const [index, stop] of crew.stops.entries()) {
            const anchorId = anchorIdOf(stop);
            if (anchorId) {
              // A move-out the day is built around: recorded with its place in the route, never published.
              await tx.tbpQuarterPlanAnchor.create({
                data: {
                  organizationId,
                  planId,
                  inspectionId: anchorId,
                  technicianId: crew.technicianId,
                  date: new Date(`${crew.date}T00:00:00.000Z`),
                  onSiteMinutes: stop.onSiteMinutes,
                  positionInDay: index + 1,
                  driveSecondsForecast: whole(crew.legSeconds[index] ?? null),
                },
              });
              continue;
            }
            await tx.tbpQuarterPlanStop.update({
              where: { id: stop.stopId },
              // A visit a coordinator placed is laid out on the day and with the
              // technician they chose, so writing its day writes theirs back.
              data: {
                scheduledOn: new Date(`${crew.date}T00:00:00.000Z`),
                assignedTechnicianId: crew.technicianId,
                positionInDay: index + 1,
                driveSecondsForecast: whole(crew.legSeconds[index] ?? null),
              },
            });
          }
        }
      });
    }

    // A stop no day can take is blocked with the reason, so publish refuses
    // until somebody excludes it or changes the settings and routes again.
    const byReason = new Map<RoutingUnplacedReason, string[]>();
    for (const entry of unplaced) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), entry.stopId]);
    for (const [reason, ids] of byReason)
      await this.prisma.tbpQuarterPlanStop.updateMany({
        where: { id: { in: ids }, planId },
        data: { status: TbpStopStatus.BLOCKED, blockedCode: 'NOT_PLACED', blockedMessage: UNPLACED_MESSAGE[reason] },
      });

    const blockedCount = await this.prisma.tbpQuarterPlanStop.count({
      where: { planId, organizationId, status: TbpStopStatus.BLOCKED },
    });
    await this.prisma.tbpQuarterPlan.update({ where: { id: planId }, data: { blockedCount } });
  }
}

/** A plan's settings as its row holds them, in the form routing takes them. */
function planSettings(plan: {
  occupiedVisitMinutes: number;
  hvacVisitMinutes: number;
  maxOnSiteMinutes: number;
  maxDriveMinutes: number;
  minStopsPerDay: number;
  maxStopsPerDay: number;
  maxLegMinutes: number;
  holidays: string[];
  excludedZones: string[];
  startsOn: Date | null;
  crewTechnicianIds: string[];
  jobberUnassigned: boolean;
  groupTemplateId?: string | null;
}): Required<PlanRoutingSettings> {
  return {
    groupTemplateId: plan.groupTemplateId ?? null,
    jobberUnassigned: plan.jobberUnassigned,
    occupiedVisitMinutes: plan.occupiedVisitMinutes,
    hvacVisitMinutes: plan.hvacVisitMinutes,
    maxOnSiteMinutes: plan.maxOnSiteMinutes,
    maxDriveMinutes: plan.maxDriveMinutes,
    minStopsPerDay: plan.minStopsPerDay,
    maxStopsPerDay: plan.maxStopsPerDay,
    maxLegMinutes: plan.maxLegMinutes,
    holidays: plan.holidays,
    excludedZones: plan.excludedZones,
    startsOn: plan.startsOn ? isoDay(plan.startsOn) : null,
    technicianIds: plan.crewTechnicianIds,
  };
}

/** Routing's settings as the plan's row holds them. */
function planColumns({ startsOn, technicianIds, ...rest }: Required<PlanRoutingSettings>) {
  return {
    ...rest,
    startsOn: startsOn ? new Date(`${startsOn}T00:00:00.000Z`) : null,
    crewTechnicianIds: technicianIds,
  };
}

/** A `DATE` column's day, `YYYY-MM-DD`. */
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

type NumericSetting = keyof Omit<
  PlanRoutingSettings,
  'holidays' | 'excludedZones' | 'startsOn' | 'technicianIds' | 'jobberUnassigned' | 'groupTemplateId'
>;

/**
 * The plan's settings with a request's changes applied, checked.
 *
 * Refused rather than clamped: a visit length of 3 or a zone 900 minutes away is
 * a typo, and routing a quarter on it would look like a plan. A start more than
 * fifteen days from the quarter's first day is not the office's rule
 * (2026-09-19); the quarter's own first day is kept as no start of its own.
 */
export function routingSettings(
  current: Required<PlanRoutingSettings>,
  input: PlanRoutingSettings,
  quarter: Quarter,
): Required<PlanRoutingSettings> {
  const within = (name: NumericSetting, min: number, max: number) => {
    const value = input[name] ?? current[name];
    if (!Number.isInteger(value) || value < min || value > max)
      throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', `${name} must be a whole number from ${min} to ${max}.`);
    return value;
  };
  const minStopsPerDay = within('minStopsPerDay', 1, MAX_STOPS_PER_DAY);
  const maxStopsPerDay = within('maxStopsPerDay', 1, MAX_STOPS_PER_DAY);
  if (minStopsPerDay > maxStopsPerDay)
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'minStopsPerDay must not be more than maxStopsPerDay.');
  const holidays = input.holidays ?? current.holidays;
  if (!Array.isArray(holidays) || holidays.length > 100 || holidays.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day)))
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'Closed days must be dates written as YYYY-MM-DD.');
  const startsOn = input.startsOn === undefined ? current.startsOn : input.startsOn;
  if (startsOn !== null) {
    const { earliest, latest } = planStartRange(quarter);
    const day = new Date(`${startsOn}T00:00:00.000Z`);
    if (
      typeof startsOn !== 'string' ||
      Number.isNaN(day.getTime()) ||
      isoDay(day) !== startsOn ||
      startsOn < earliest ||
      startsOn > latest
    )
      throw new ApplicationError(
        422,
        'INVALID_PLAN_START',
        `${quarterLabel(quarter)} can start from ${earliest} to ${latest}: fifteen days either side of the quarter’s first day.`,
      );
  }
  /**
   * Zone numbers, and nothing that would leave the quarter with no work.
   *
   * Refused rather than clamped, like every other setting here: excluding
   * every zone is a mistake, and a quarter built on it would look like a plan
   * with nothing in it rather than like the error it is.
   */
  const excludedZones = input.excludedZones ?? current.excludedZones;
  if (
    !Array.isArray(excludedZones) ||
    excludedZones.length > 20 ||
    excludedZones.some((zone) => typeof zone !== 'string' || !/^\d{1,3}$/.test(zone.trim()))
  )
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'Zones to leave out must be zone numbers.');

  const technicianIds = input.technicianIds ?? current.technicianIds;
  if (!Array.isArray(technicianIds) || technicianIds.length > MAX_PLAN_TECHNICIANS || technicianIds.some((id) => typeof id !== 'string'))
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'Choose the technicians to send out on the plan.');
  /**
   * What the caller asked for is checked; what the plan holds is trusted.
   *
   * The column is `NOT NULL DEFAULT false`, so a plan always has an answer — and
   * validating the *current* value as well would turn a caller's mistake and a
   * stored row into the same refusal, which is a worse message and a worse test.
   * `?? false` is for a caller that assembles the settings by hand rather than
   * reading a plan.
   *
   * `??` and not a truthiness check on the input: `false` is an answer, so
   * unticking the box on a rebuild has to beat the `true` the plan already says.
   */
  if (input.jobberUnassigned !== undefined && typeof input.jobberUnassigned !== 'boolean')
    throw new ApplicationError(
      422,
      'INVALID_PLAN_SETTINGS',
      'Whether Jobber visits go out unassigned must be true or false.',
    );
  const jobberUnassigned = input.jobberUnassigned ?? current.jobberUnassigned ?? false;
  /**
   * Nobody chosen is an answer only for a quarter sent out to nobody (the
   * office, 2026-09-29: "I already clicked unassigned ... but still needs to
   * select a technician?"). Otherwise the days would silently go to whoever the
   * planning profiles name, which is not what an empty choice says.
   */
  if (Array.isArray(input.technicianIds) && input.technicianIds.length === 0 && !jobberUnassigned)
    throw new ApplicationError(
      422,
      'INVALID_PLAN_SETTINGS',
      'Choose the technicians to send out on the plan, or send its visits out unassigned.',
    );
  /**
   * A template's id, or null for the planner's own grouping. Left out, the plan
   * keeps what it had -- so a nightly rebuild groups the way the office chose.
   * Whether the template exists is the planner's to check: that needs the
   * database, and this does not.
   */
  const groupTemplateId = input.groupTemplateId === undefined ? (current.groupTemplateId ?? null) : input.groupTemplateId;
  if (groupTemplateId !== null && (typeof groupTemplateId !== 'string' || !UUID.test(groupTemplateId)))
    throw new ApplicationError(422, 'INVALID_PLAN_SETTINGS', 'Choose a group template, or the planner’s own grouping.');
  return {
    groupTemplateId,
    jobberUnassigned,
    occupiedVisitMinutes: within('occupiedVisitMinutes', 5, 240),
    hvacVisitMinutes: within('hvacVisitMinutes', 5, 240),
    maxOnSiteMinutes: within('maxOnSiteMinutes', 30, 720),
    maxDriveMinutes: within('maxDriveMinutes', 0, 480),
    minStopsPerDay,
    maxStopsPerDay,
    maxLegMinutes: within('maxLegMinutes', 5, 120),
    holidays: [...new Set(holidays)].sort(),
    excludedZones: [...new Set(excludedZones.map((zone) => zone.trim()))].sort(byZoneNumber),
    startsOn: startsOn === quarterFirstDay(quarter) ? null : startsOn,
    technicianIds: [...new Set(technicianIds)],
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A template's groups as the quarter's stops, in each group's order: every
 * visit this quarter at each building it names, a building's visits together.
 * A building with no visit this quarter -- its tenants left the package -- is
 * simply not there, and its group is that much shorter.
 */
export function templateStops(
  template: Pick<TemplateForPlanning, 'groups'>,
  stops: readonly PlannableStop[],
  buildings: ReadonlyMap<string, string>,
): { groups: string[][]; targets: number[]; notInTemplate: number } {
  const atBuilding = new Map<string, string[]>();
  for (const stop of stops) {
    const building = buildings.get(stop.stopId);
    if (building) atBuilding.set(building, [...(atBuilding.get(building) ?? []), stop.stopId]);
  }
  const named = new Set(template.groups.flatMap((group) => group.buildingIds));
  return {
    groups: template.groups.map((group) => group.buildingIds.flatMap((building) => atBuilding.get(building) ?? [])),
    /**
     * The room each group has for a property new since the template was saved:
     * the size it was drawn to, so a group already at it takes none. A target
     * counts properties and a group holds visits, so a building of two
     * tenancies fills two of it.
     */
    targets: template.groups.map((group) => group.target),
    notInTemplate: stops.filter((stop) => !named.has(buildings.get(stop.stopId) ?? '')).length,
  };
}

/** A visit a coordinator placed by hand: the day and the technician they chose. */
interface Pin {
  date: string;
  technicianId: string;
}

/** A coordinator's placed visits, as the technician-days they make. */
function pinnedCrews(stops: readonly PlannableStop[], pins: ReadonlyMap<string, Pin>) {
  const crews = new Map<string, { date: string; technicianId: string; stops: PlannableStop[] }>();
  for (const stop of stops) {
    const pin = pins.get(stop.stopId);
    if (!pin) continue;
    const key = crewKey(pin.date, pin.technicianId);
    const crew = crews.get(key) ?? { date: pin.date, technicianId: pin.technicianId, stops: [] };
    crew.stops.push(stop);
    crews.set(key, crew);
  }
  return [...crews.values()];
}

/** A drive nothing could measure is Infinity in the matrix; the database takes a whole number or nothing. */
const whole = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value));

/** A measured technician-day, as its row holds it. */
function dayRow(crew: MeasuredCrew) {
  const first = crew.stops[0]!;
  // A move-out the day is built around takes its time on site, but is not one of the day's visits.
  const visits = crew.stops.filter((stop) => anchorIdOf(stop) === null);
  return {
    stopCount: visits.length,
    onSiteMinutes: crew.stops.reduce((total, stop) => total + stop.onSiteMinutes, 0),
    hvacStopCount: visits.filter((stop) => stop.inspectionType === InspectionType.HVAC).length,
    totalDriveSeconds: whole(crew.totalDriveSeconds),
    totalDriveMeters: whole(crew.totalDriveMeters),
    homeDriveSeconds: whole(crew.homeDriveSeconds),
    homeDriveMeters: whole(crew.homeDriveMeters),
    // A day routed from home says so, and does not copy the home's coordinates
    // onto every day of the quarter: the planning profile stays the one place a
    // technician's address is kept.
    originLatitude: crew.fromHome ? null : first.latitude,
    originLongitude: crew.fromHome ? null : first.longitude,
    originKind: crew.fromHome ? PlanOriginKind.HOME : PlanOriginKind.FIRST_STOP,
    durationSource: crew.durationSource,
    departureAssumedAt: businessInstant(crew.date, DAY_STARTS_AT),
  };
}

/** The middle of each zone's stops, as a place. */
function zoneMiddles(stops: readonly PlannableStop[]): Map<string, GeoPoint> {
  const sums = new Map<string, { latitude: number; longitude: number; count: number }>();
  for (const stop of stops) {
    if (!stop.zone) continue;
    const sum = sums.get(stop.zone) ?? { latitude: 0, longitude: 0, count: 0 };
    sums.set(stop.zone, { latitude: sum.latitude + stop.latitude, longitude: sum.longitude + stop.longitude, count: sum.count + 1 });
  }
  return new Map(
    [...sums.entries()].map(([zone, sum]) => [zone, { latitude: sum.latitude / sum.count, longitude: sum.longitude / sum.count }]),
  );
}

/**
 * Every stop with a zone: its own, or for the few the tenant report leaves
 * without one ("Not Set"), the zone whose middle is nearest -- so it is still
 * worked by whoever has that part of town that week.
 */
export function withZones<T extends PlannableStop>(stops: readonly T[]): T[] {
  const middles = zoneMiddles(stops);
  if (middles.size === 0) return [...stops];
  return stops.map((stop) => {
    if (stop.zone) return stop;
    let nearest: string | null = null;
    let nearestMetres = Number.POSITIVE_INFINITY;
    for (const [zone, middle] of middles) {
      const metres = haversineMeters(stop, middle);
      if (metres < nearestMetres) {
        nearest = zone;
        nearestMetres = metres;
      }
    }
    return { ...stop, zone: nearest };
  });
}

/**
 * The zones the crew goes round, in order, and the zones none of them can reach.
 *
 * A zone is out of reach when every crew member's home is further from its
 * middle than the day's drive allows even to get there -- zone 5, some 200 km
 * from the three homes in Q4 2026. Left in the circle, it would take a person's
 * week and leave another zone without anybody; out of it, its visits are a trip
 * of back-to-back days for the crew member living nearest it (the office,
 * 2026-09-18). A crew member with no home on file starts at their first job, so
 * reaches anywhere.
 */
export function zoneCircle(
  stops: readonly PlannableStop[],
  roster: Roster,
  maxDriveMinutes: number,
): { circle: string[]; outOfReach: string[] } {
  const zones = [...zoneMiddles(stops).entries()].sort(([left], [right]) => byZoneNumber(left, right));
  // Without a crew there is nobody to be out of reach of: routing says so per stop.
  if (roster.technicianIds.length === 0) return { circle: zones.map(([zone]) => zone), outOfReach: [] };
  const reachable = (middle: GeoPoint) =>
    roster.technicianIds.some((technicianId) => {
      const home = roster.homes.get(technicianId);
      return !home || estimatedDriveMinutes(home, middle) <= maxDriveMinutes;
    });
  return {
    circle: zones.filter(([, middle]) => reachable(middle)).map(([zone]) => zone),
    outOfReach: zones.filter(([, middle]) => !reachable(middle)).map(([zone]) => zone),
  };
}

/** The drive through stops in the order given, in seconds, from a matrix. */
function pathCost(matrix: readonly (readonly number[])[], order: readonly number[]): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1)
    total += matrix[order[index - 1]!]?.[order[index]!] ?? Number.POSITIVE_INFINITY;
  return total;
}

/**
 * The same day driven the other way, when that starts nearer home.
 *
 * Used only when the day cannot be routed from the home itself (`dayOrder`).
 * Between two orders within a couple of minutes of each other, the one that
 * starts at the end nearer the technician's home is the one they would choose.
 */
function orientTowardHome(
  order: number[],
  matrix: readonly (readonly number[])[],
  stops: readonly GeoPoint[],
  home: GeoPoint | undefined,
  toleranceSeconds: number,
): number[] {
  if (!home || order.length < 2) return order;
  const reversed = [...order].reverse();
  const nearerHome = haversineMeters(home, stops[reversed[0]!]!) < haversineMeters(home, stops[order[0]!]!);
  return nearerHome && pathCost(matrix, reversed) <= pathCost(matrix, order) + toleranceSeconds ? reversed : order;
}

/**
 * The order to drive a day in: from the technician's home, the order that drives
 * least in all.
 *
 * The office keeps the driving as short as the visits allow (2026-09-17), and a
 * day is driven from home. So the route is the shortest from home through every
 * property, which starts at or near the property nearest home; between two that
 * drive the same, the day starts at the property nearer home. Without a home,
 * or where nothing measured the drive from it, the day keeps the shortest path
 * through the properties alone, started at the end nearer home.
 *
 * No drive from one property to the next longer than `maxLegSeconds` (the
 * office, 2026-09-19: twenty minutes), where any order of the day manages it:
 * such a leg is priced out of the choice, so the day takes a slightly longer
 * way round rather than one long hop. The drive from home is not held to it.
 *
 * `between` is the stops' own matrix; `fromHome` the drive from home to each.
 */
function dayOrder(
  measured: readonly (readonly number[])[],
  fromHome: readonly number[] | null,
  stops: readonly GeoPoint[],
  home: GeoPoint | undefined,
  maxLegSeconds?: number,
): number[] {
  const between = maxLegSeconds
    ? measured.map((row) => row.map((seconds) => (seconds > maxLegSeconds ? seconds + OVER_LEG_SECONDS : seconds)))
    : measured;
  const free = orientTowardHome(shortestOpenPathOrder(between), between, stops, home, HOME_END_TOLERANCE_SECONDS);
  if (!fromHome || !home || stops.length === 0) return free;
  // The solver's origin is row zero; nothing ever drives back to it.
  const withHome = [[0, ...fromHome], ...between.map((row) => [0, ...row])];
  const solved = shortestRouteOrder(withHome).map((index) => index - 1);
  if (solved.length !== stops.length) return free;
  const total = (order: readonly number[]) => (order.length ? fromHome[order[0]!]! : 0) + pathCost(between, order);
  const reversed = [...solved].reverse();
  const homeFirst =
    total(reversed) <= total(solved) && haversineMeters(home, stops[reversed[0]!]!) < haversineMeters(home, stops[solved[0]!]!)
      ? reversed
      : solved;
  return Number.isFinite(total(homeFirst)) ? homeFirst : free;
}

/** Stops ordered and measured from a matrix that holds them all, and the home when it has one. */
function inMatrixOrder(
  stops: readonly PlannableStop[],
  matrix: DayMatrix,
  home: GeoPoint | undefined,
  maxLegSeconds?: number,
): Pick<
  MeasuredCrew,
  'stops' | 'legSeconds' | 'totalDriveSeconds' | 'totalDriveMeters' | 'homeDriveSeconds' | 'homeDriveMeters'
> {
  const indexes = stops.map((stop) => matrix.index.get(stop.stopId)!);
  const durations = indexes.map((from) => indexes.map((to) => matrix.durations[from]![to]!));
  const homeRow = matrix.homeIndex === null ? null : matrix.durations[matrix.homeIndex]!;
  const order = dayOrder(durations, homeRow ? indexes.map((to) => homeRow[to]!) : null, stops, home, maxLegSeconds);
  const ordered = order.map((index) => stops[index]!);
  const legSeconds = order.map((index, position) => (position === 0 ? null : durations[order[position - 1]!]![index]!));
  const distances = matrix.distances;
  const first = order.length ? indexes[order[0]!]! : null;
  const homeSeconds = homeRow && first !== null ? homeRow[first]! : null;
  const homeMeters = distances && matrix.homeIndex !== null && first !== null ? distances[matrix.homeIndex]![first]! : null;
  const betweenMeters = distances
    ? pathCost(
        indexes.map((from) => indexes.map((to) => distances[from]![to]!)),
        order,
      )
    : null;
  return {
    stops: ordered,
    legSeconds,
    totalDriveSeconds: pathCost(durations, order),
    totalDriveMeters: betweenMeters,
    homeDriveSeconds: homeSeconds !== null && Number.isFinite(homeSeconds) ? homeSeconds : null,
    homeDriveMeters: homeMeters !== null && Number.isFinite(homeMeters) ? homeMeters : null,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
