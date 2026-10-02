'use client';

import type { GroupTemplateOp } from '@texasrenters/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, ApiError } from './api';
import type { OfficeSheetRow } from './planning';

/**
 * The benefit-package plan API, for the plan page.
 *
 * Kept beside `queries.ts` rather than inside it: one page reads these, and
 * they change with the planner rather than with the rest of the console.
 */

const PLANNING = '/api/v1/admin/planning';

export type PlanStatus = 'DRAFT' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISH_FAILED' | 'CANCELLED';
export type PlanStopStatus = 'PLANNED' | 'BLOCKED' | 'UNSCHEDULED' | 'EXCLUDED' | 'PUBLISHED' | 'FAILED';
export type PlanInspectionType = 'OCCUPIED' | 'HVAC';

export interface PlanSettings {
  occupiedVisitMinutes: number;
  hvacVisitMinutes: number;
  maxOnSiteMinutes: number;
  /** How far a zone may be from the crew's homes. Not a limit on a day's driving. */
  maxDriveMinutes: number;
  /** The visits the planner groups into a day: nine (the office, 2026-09-19). */
  minStopsPerDay: number;
  /** The most a day may hold, with the visits the office adds by hand: twelve. */
  maxStopsPerDay: number;
  /** The longest drive between two of a day's properties, in minutes: twenty. The drive from home is not held to it. */
  maxLegMinutes: number;
  holidays: string[];
  /** The plan's first day when it is not the quarter's: up to fifteen days either side of it. */
  startsOn: string | null;
  /** Who the coordinator chose to send out; empty, the crew on the technicians' planning profiles. */
  crewTechnicianIds: string[];
  /**
   * Send this plan's visits to Jobber with nobody on them, so they arrive in
   * Jobber's Unassigned list for the office to hand out there.
   *
   * Only Jobber's copy: the days here still belong to the technicians the plan
   * was built for, which is what the phone and the calendar read.
   */
  jobberUnassigned: boolean;
}

export interface PlanQuarter extends PlanSettings {
  id: string;
  quarterYear: number;
  quarterNumber: number;
  quarterStartsOn: string;
  status: PlanStatus;
  stopCount: number;
  blockedCount: number;
  publishedCount: number;
  unverifiedEnrollmentCount: number;
  generatedAt: string;
  publishedAt: string | null;
  lastError: string | null;
  officeDetailsImportedAt: string | null;
  hvacStopCount: number;
  occupiedStopCount: number;
  /** The group template the days were last laid out from; null for the planner's own grouping. */
  groupTemplateId?: string | null;
  /** The template's revision when the days were laid out from it. */
  groupTemplateRevision?: number | null;
  groupTemplate?: { id: string; name: string; revision: number; archivedAt: string | null } | null;
}

export interface PlanStop {
  id: string;
  sequence: number;
  previousSequence: number | null;
  /** The day of its visit last quarter, whose month of the quarter this one keeps; null for none. */
  previousVisitOn?: string | null;
  /** The month of its own quarter that visit was in, 1 to 3, where the day alone cannot say. */
  previousVisitMonth?: number | null;
  orderSource: 'PRIOR_QUARTER' | 'CARRIED_SKIP' | 'NEW_ENROLLMENT';
  zone: string | null;
  /** The property, for the map: null where Propertyware has no location for it. */
  latitude: number | null;
  longitude: number | null;
  scheduledOn: string | null;
  positionInDay: number | null;
  assignedTechnicianId: string | null;
  assignedTechnician: { id: string; displayName: string } | null;
  unitResolution: string;
  status: PlanStopStatus;
  blockedCode: string | null;
  blockedMessage: string | null;
  inspectionType: PlanInspectionType;
  inspectionTypeReason: string | null;
  inspectionTypeNeedsReview: boolean;
  inspectionTypeOverriddenAt: string | null;
  onSiteMinutes: number | null;
  driveSecondsForecast: number | null;
  officeDetails: string | null;
  visitTitle: string | null;
  visitDetails: string | null;
  inspectionId: string | null;
  jobberVisitId: string | null;
  hvacFilterSizes: string[];
  scheduleOverriddenAt: string | null;
  technicianOverriddenAt: string | null;
  /** Set when a coordinator wrote the title, the Details, the length or the unit; a rebuild keeps them. */
  visitTitleOverriddenAt: string | null;
  visitDetailsOverriddenAt: string | null;
  onSiteMinutesOverriddenAt: string | null;
  unitOverriddenAt: string | null;
  previousTechnician: { id: string; displayName: string | null } | null;
  propertywareUnit: { id: string; name: string; addressLine1: string | null } | null;
  /** The building's units, when it has any: in a building of several, a coordinator chooses the tenancy's. */
  buildingUnits: { id: string; name: string; addressLine1: string | null }[];
  tenant: {
    leaseName: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    managementPlan: string | null;
    hvacPlan: string | null;
    startDate: string | null;
    endDate: string | null;
    hvacFilterLocation: string | null;
    hvacFilterSizes: string[];
    lastFilterDelivery: string | null;
    lastHvacInspection: string | null;
    lastOccupiedInspection: string | null;
  };
}

export interface PlanDayStop {
  id: string;
  /**
   * Which building, so the one map can pick the day's properties out of the
   * whole portfolio. Null only for a stop whose building has since gone.
   */
  buildingId: string | null;
  sequence: number;
  positionInDay: number | null;
  inspectionType: PlanInspectionType;
  onSiteMinutes: number | null;
  driveSecondsForecast: number | null;
  zone: string | null;
  status: PlanStopStatus;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PlanDay {
  id: string;
  date: string;
  technicianId: string;
  technician: { id: string; displayName: string };
  stopCount: number;
  onSiteMinutes: number;
  hvacStopCount: number;
  /** Between the day's properties, first to last. */
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  /** From the technician's home to the first property, when the day was routed from home. Shown apart. */
  homeDriveSeconds: number | null;
  homeDriveMeters: number | null;
  /** `HOME` when the day was routed from the technician's home; `FIRST_STOP` when there was none on file. */
  originKind: string;
  durationSource: 'GOOGLE_TRAFFIC_AWARE' | 'MAPBOX_FREE_FLOW' | 'OSRM_FREE_FLOW' | 'HAVERSINE' | null;
  departureAssumedAt: string | null;
  /**
   * The office's template group the day was laid out from, shown in its name
   * and colour as in the Group maker; null for a day the planner grouped, and
   * absent from a server older than this.
   */
  /**
   * The office's template group the day was laid out from, as it was then: its
   * number, name and colour stay when the template is saved again, and the
   * link to the group (`id`) does not.
   */
  templateGroup?: { id: string | null; position: number; name: string; color: string } | null;
  stops: PlanDayStop[];
  /**
   * The move-outs and move-ins the day is built around; `onSiteMinutes` includes
   * theirs, `stopCount` does not, and each takes the place of three visits.
   */
  anchors?: PlanDayAnchor[];
}

/**
 * A move-out or move-in a planned day is built around (the office, 2026-09-17:
 * TBPs are done around move-outs; 2026-09-18: move-ins too, three visits fewer each).
 */
export interface PlanDayAnchor {
  id: string;
  inspectionId: string;
  /** Which building, as for a visit. */
  buildingId: string | null;
  kind: 'MOVE_OUT' | 'MOVE_IN';
  /** 1-based among all the day's stops, visits included. */
  positionInDay: number | null;
  onSiteMinutes: number;
  driveSecondsForecast: number | null;
  address: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Whoever it is assigned to now: somebody else than the day's technician when it was reassigned since. */
  assignedTechnician: { id: string; displayName: string } | null;
  /** `YYYY-MM-DD`, its date now: another day's than this one when it moved after the plan was laid out. */
  scheduledOn: string;
  cancelled: boolean;
}

export interface PlanRoutingSummary {
  planId: string;
  placed: number;
  unplaced: { stopId: string; reason: string }[];
  days: number;
  durationSource: PlanDay['durationSource'];
  settings: PlanSettings;
  /** The group template the days came from; null for the planner's own grouping. */
  template?: {
    id: string;
    name: string;
    revision: number;
    days: number;
    notInTemplate: number;
    /** Visits move-out days gave up, put on the Monday after; absent from a server older than this. */
    toMondays?: number;
  } | null;
}

export interface OfficeDetailsAddress {
  address: string;
  city: string | null;
  postalCode: string | null;
}

export interface OfficeDetailsImport {
  planId: string;
  rows: number;
  matched: number;
  unmatched: OfficeDetailsAddress[];
  ambiguous: OfficeDetailsAddress[];
  duplicates: OfficeDetailsAddress[];
  stopsWithoutOfficeDetails: number;
}

/** A visit whose filter size Propertyware does not hold, for the office to chase. */
export interface TenancyWithoutFilterSize {
  stopId: string;
  tenancyId: string;
  address: string;
}

/** What re-reading a quarter's filter sizes from the tenant report changed. */
export interface FilterSizeRefresh {
  planId: string;
  stops: number;
  updated: number;
  detailsRewritten: number;
  jobberQueued: number;
  keptOverridden: number;
  /** Left alone: the visit has been walked or called off, and is history. */
  keptFinished: number;
  /** Left alone: somebody edited this visit's text in the console, and their words win. */
  keptEditedInConsole: number;
  /** Left alone: the unit it is booked at is no longer active. */
  keptUnresolvedUnit: number;
  /** Changed here, but this server does not send edits to Jobber. */
  notSentToJobber: number;
  failed: number;
  jobberPushDisabled: boolean;
  stillMissing: TenancyWithoutFilterSize[];
}

/** A day put in the order that drives least from home, and what that did to its driving. */
export interface OptimizedPlanDay {
  dayId: string;
  date: string;
  technicianId: string;
  /** Whether its order is not the one it had. */
  changed: boolean;
  /** Between its properties, before and after, in seconds. */
  driveSecondsBefore: number | null;
  driveSecondsAfter: number | null;
  /** From home to its first property, before and after. */
  homeDriveSecondsBefore: number | null;
  homeDriveSecondsAfter: number | null;
}

export interface PlanDayRoute {
  source: string | null;
  /** `[lat, lng]`, between the day's stops. Empty when nothing could draw the day. */
  geometry: [number, number][];
  /** `[lat, lng]`, from home to the first stop. Empty when the day has no home or nothing drew it. */
  homeGeometry: [number, number][];
  /** The technician's home -- where the day starts, the "From" on the map -- when one is on file. */
  home: { latitude: number; longitude: number; address: string | null } | null;
  legs: { durationSeconds: number; distanceMeters: number }[];
}

/**
 * The crew a quarter goes out with and the zones it goes round. Each crew member
 * has a zone a day, moving one on each day (the office, 2026-10-03); which zone a
 * day is in is the day's own.
 */
export interface PlanRotation {
  /** In the order the zones go round. */
  crew: { technicianId: string; displayName: string | null; hasHome: boolean }[];
  zones: string[];
  /** Zones nobody on the crew lives within the day's drive of. */
  outOfReach: string[];
}

/** A technician a visit can be given to, the benefit-package crew first. */
export interface PlanTechnician {
  id: string;
  displayName: string;
  /** Place in the crew's zone rotation; null is not on the crew. */
  crewOrder: number | null;
  hasHome: boolean;
}

/**
 * A quarter to build, for the technicians and from the day the coordinator
 * chose (the office, 2026-09-19). Left out, the plan keeps what it had.
 */
export interface PlanBuildInput {
  year: number;
  quarter: number;
  technicianIds?: string[];
  /** `YYYY-MM-DD`, up to fifteen days either side of the quarter's first day. */
  startsOn?: string;
  /** Visits in a day. Nine is the planner's own default; ten fits the time. */
  maxStopsPerDay?: number;
  minStopsPerDay?: number;
  /** Zones left out of the build, by number -- the office works 1 to 4. */
  excludedZones?: string[];
  /**
   * One of the office's group templates to lay the days out from, or null for
   * the planner's own grouping. Left out, the plan keeps what it had.
   */
  groupTemplateId?: string | null;
}

/** A coordinator's change to one visit in a draft; anything left out stays as it is. */
export interface PlanStopEdit {
  /** `YYYY-MM-DD`. */
  scheduledOn?: string;
  assignedTechnicianId?: string;
  propertywareUnitId?: string;
  visitTitle?: string;
  visitDetails?: string;
  onSiteMinutes?: number;
  inspectionType?: PlanInspectionType;
}

export interface PublishSummary {
  planId: string;
  published: number;
  adopted: number;
  /** Sent to Jobber with no day on them, for the office to schedule there. */
  unscheduled: number;
  failed: number;
  status: PlanStatus;
}

export const planningKeys = {
  all: ['admin', 'planning'] as const,
  quarters: ['admin', 'planning', 'quarters'] as const,
  stops: (planId: string) => ['admin', 'planning', planId, 'stops'] as const,
  days: (planId: string) => ['admin', 'planning', planId, 'days'] as const,
  dayRoute: (planId: string, dayId: string) => ['admin', 'planning', planId, 'days', dayId, 'route'] as const,
  rotation: (planId: string) => ['admin', 'planning', planId, 'rotation'] as const,
  technicians: ['admin', 'planning', 'technicians'] as const,
  groupFile: ['admin', 'planning', 'group-file'] as const,
  groupTemplates: ['admin', 'planning', 'group-templates'] as const,
  groupTemplate: (id: string) => ['admin', 'planning', 'group-templates', id] as const,
  groupMakerProperties: ['admin', 'planning', 'group-maker', 'properties'] as const,
  lateMoveOuts: (planId: string) => ['admin', 'planning', planId, 'late-move-outs'] as const,
};

/**
 * A move-out or move-in booked onto a technician's benefit-package day after
 * the quarter was published, with the visits to move to the Monday after (the
 * office, 2026-10-01). See `LateMoveOutService` on the server.
 */
export interface LateMoveOut {
  date: string;
  technician: { id: string; displayName: string };
  bookings: { inspectionId: string; kind: 'MOVE_OUT' | 'MOVE_IN'; address: string | null }[];
  /** The day's benefit-package visits that can still be moved. */
  visits: number;
  /** The visits furthest from the bookings, three for each. */
  suggested: { inspectionId: string; address: string | null; metresFromBooking: number }[];
  /** The Monday after, kept for rescheduled visits; null when the quarter has none left. */
  monday: string | null;
  /** What the technician already has on that Monday. */
  mondayLoad: number;
}

export interface LateMoveOuts {
  conflicts: LateMoveOut[];
  /** Whether a visit moved here reaches Jobber; off, a Jobber visit cannot be moved from the console. */
  jobberEditsPushed: boolean;
}

export const usePlanLateMoveOuts = (planId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: planningKeys.lateMoveOuts(planId ?? ''),
    queryFn: ({ signal }) => api<LateMoveOuts>(`${PLANNING}/quarters/${planId}/late-move-outs`, { signal }),
    enabled: Boolean(planId) && enabled,
  });

/** A property the Group maker can put in a group: an enrolled building, its tenancies together. */
export interface GroupMakerProperty {
  buildingId: string;
  address: string;
  city: string | null;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  /** A postcode centre rather than the house. */
  approximate: boolean;
  zone: string | null;
  hvacPlans: string[];
  leases: string[];
  units: string[];
}

/** A group template as the list shows it. */
export interface GroupTemplateSummary {
  id: string;
  name: string;
  /** The one the daily planner builds a new quarter from. */
  isActive: boolean;
  minutesPerProperty: number;
  /** One more on every save. */
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: { id: string; displayName: string | null } | null;
  groupCount: number;
  propertyCount: number;
}

export interface GroupTemplateGroup {
  /** The same on every browser, so live edits can name the group. */
  id: string;
  position: number;
  name: string;
  color: string;
  target: number;
  /** In the group's driving order. */
  buildingIds: string[];
}

export interface GroupTemplateDetail extends Omit<GroupTemplateSummary, 'groupCount' | 'propertyCount'> {
  groups: GroupTemplateGroup[];
  /** Every member's street address, by building id: names one no longer in the package. */
  addresses?: Record<string, string>;
}

/** A template as the Group maker saves it: its groups replace the ones it had. */
export interface GroupTemplateInput {
  name: string;
  minutesPerProperty?: number;
  groups: Omit<GroupTemplateGroup, 'position' | 'id'>[];
  /** The revision the edit started from; absent for a new one. */
  revision?: number;
}

export type GroupTemplateMatch = { buildingId: string; outcome: 'MATCHED' } | { buildingId: null; outcome: 'NONE' | 'AMBIGUOUS' };

/** Every enrolled property with a position, for the Group maker. */
export const useGroupMakerProperties = (enabled = true) =>
  useQuery({
    queryKey: planningKeys.groupMakerProperties,
    queryFn: ({ signal }) =>
      api<{ properties: GroupMakerProperty[]; withoutPosition: number }>(`${PLANNING}/group-maker/properties`, { signal }),
    enabled,
    // Read once while the maker is open: the map numbers its properties by this list, and a refetch
    // underneath somebody grouping could renumber them mid-edit.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

export const useGroupTemplates = (enabled = true) =>
  useQuery({
    queryKey: planningKeys.groupTemplates,
    queryFn: ({ signal }) => api<GroupTemplateSummary[]>(`${PLANNING}/group-templates`, { signal }),
    enabled,
  });

export const useGroupTemplate = (id: string | null) =>
  useQuery({
    queryKey: planningKeys.groupTemplate(id ?? ''),
    queryFn: ({ signal }) => api<GroupTemplateDetail>(`${PLANNING}/group-templates/${id}`, { signal }),
    enabled: Boolean(id),
    // An open template is the office's work in progress: never swapped underneath them by a refetch.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });

/** A batch of live edits to a group template (2026-10-01); the server passes it on to everyone with it open. */
export const postGroupTemplateOps = (id: string, batchId: string, ops: GroupTemplateOp<string>[]) =>
  api<{ revision: number }>(`${PLANNING}/group-templates/${id}/ops`, {
    method: 'POST',
    body: JSON.stringify({ batchId, ops }),
  });

/** A group template read again, outside the cache: a live copy catching up. */
export const readGroupTemplate = (id: string) => api<GroupTemplateDetail>(`${PLANNING}/group-templates/${id}`);

export function useGroupTemplateMutations() {
  const client = useQueryClient();
  const send = <T>(path: string, method: 'POST' | 'PUT', body?: unknown) =>
    api<T>(`${PLANNING}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const saved = (template: GroupTemplateDetail) => {
    client.setQueryData(planningKeys.groupTemplate(template.id), template);
    // In the list at once, so a template just made can be opened before the list is read again.
    const { groups, ...rest } = template;
    const summary: GroupTemplateSummary = {
      ...rest,
      groupCount: groups.length,
      propertyCount: groups.reduce((total, group) => total + group.buildingIds.length, 0),
    };
    client.setQueryData<GroupTemplateSummary[]>(planningKeys.groupTemplates, (list) =>
      list?.some((entry) => entry.id === summary.id)
        ? list.map((entry) => (entry.id === summary.id ? summary : entry))
        : [summary, ...(list ?? [])],
    );
    void client.invalidateQueries({ queryKey: planningKeys.groupTemplates });
  };
  return {
    create: useMutation({
      mutationFn: (input: GroupTemplateInput) => send<GroupTemplateDetail>('/group-templates', 'POST', input),
      onSuccess: saved,
    }),
    save: useMutation({
      mutationFn: ({ id, input }: { id: string; input: GroupTemplateInput }) =>
        send<GroupTemplateDetail>(`/group-templates/${id}`, 'PUT', input),
      onSuccess: saved,
    }),
    setActive: useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) =>
        send<GroupTemplateDetail>(`/group-templates/${id}/active`, 'POST', { active }),
      onSuccess: saved,
    }),
    archive: useMutation({
      mutationFn: (id: string) => send<GroupTemplateDetail>(`/group-templates/${id}/archive`, 'POST'),
      onSuccess: saved,
    }),
    match: useMutation({
      mutationFn: (rows: { address: string; postalCode: string | null }[]) =>
        send<{ matches: GroupTemplateMatch[] }>('/group-templates/match', 'POST', { rows }),
    }),
  };
}

/** The office's groups file as the server holds it: the CSV exactly as it is on disk. */
export interface PlanGroupFile {
  fileName: string;
  csv: string;
  modifiedAt: string;
}

/**
 * The groups file in the server's `data/` folder, which the Groups map opens
 * by default -- or null when there is none, or none for this organization.
 *
 * Asked for only while the Groups tab is open: it names every tenant, and a
 * page that never shows it has no business holding it.
 */
export const useGroupFileOnServer = (enabled: boolean) =>
  useQuery({
    queryKey: planningKeys.groupFile,
    queryFn: async ({ signal }) => {
      try {
        return await api<PlanGroupFile>(`${PLANNING}/group-file`, { signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled,
    retry: false,
  });

/** The most stops one request returns; a plan larger than this is read a page at a time. */
const STOP_PAGE = 500;

export const usePlanQuarters = () =>
  useQuery({
    queryKey: planningKeys.quarters,
    queryFn: ({ signal }) => api<PlanQuarter[]>(`${PLANNING}/quarters`, { signal }),
  });

export const usePlanStops = (planId: string | undefined) =>
  useQuery({
    queryKey: planningKeys.stops(planId ?? ''),
    queryFn: async ({ signal }) => {
      const stops: PlanStop[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await api<PlanStop[]>(
          `${PLANNING}/quarters/${planId}/stops?page=${page}&pageSize=${STOP_PAGE}`,
          { signal },
        );
        stops.push(...batch);
        if (batch.length < STOP_PAGE) return stops;
      }
    },
    enabled: Boolean(planId),
  });

export const usePlanDays = (planId: string | undefined) =>
  useQuery({
    queryKey: planningKeys.days(planId ?? ''),
    queryFn: ({ signal }) => api<PlanDay[]>(`${PLANNING}/quarters/${planId}/days`, { signal }),
    enabled: Boolean(planId),
  });

export const usePlanRotation = (planId: string | undefined) =>
  useQuery({
    queryKey: planningKeys.rotation(planId ?? ''),
    queryFn: ({ signal }) => api<PlanRotation>(`${PLANNING}/quarters/${planId}/rotation`, { signal }),
    enabled: Boolean(planId),
  });

/** Who a visit can be given to, read only when a visit's window can change it. */
export const usePlanTechnicians = (enabled: boolean) =>
  useQuery({
    queryKey: planningKeys.technicians,
    queryFn: ({ signal }) => api<PlanTechnician[]>(`${PLANNING}/technicians`, { signal }),
    enabled,
    staleTime: 5 * 60_000,
  });

/** The road line through one day. Each draw is a Google call, so a drawn day is kept for the visit. */
export const usePlanDayRoute = (planId: string | undefined, dayId: string | undefined) =>
  useQuery({
    queryKey: planningKeys.dayRoute(planId ?? '', dayId ?? ''),
    queryFn: ({ signal }) => api<PlanDayRoute>(`${PLANNING}/quarters/${planId}/days/${dayId}/route`, { signal }),
    enabled: Boolean(planId && dayId),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** One move AI proposed and the plan's own rules allowed. */
export interface AdvisedMove {
  stopId: string;
  address: string | null;
  fromDate: string | null;
  toDate: string;
  toTechnicianId: string;
  toTechnicianName: string;
  /** Estimated minutes the two days save together. */
  savedMinutes: number;
  /** Why AI proposed it, as it wrote it. */
  why: string;
}

/** One it proposed and the rules refused, with the reason they refused it. */
export interface RefusedMove {
  stopId: string;
  address: string | null;
  toDate: string;
  refused: string;
}

export interface PlanAdvice {
  notes: string[];
  proposed: number;
  moves: AdvisedMove[];
  refused: RefusedMove[];
  savedMinutes: number;
  provider: string;
  modelId: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export function usePlanningMutations() {
  const client = useQueryClient();
  // Every change here moves days, stops and counts together, so the whole plan
  // is read again rather than patched piecemeal.
  const refresh = () => void client.invalidateQueries({ queryKey: planningKeys.all });
  const post = <T>(path: string, body?: unknown) =>
    api<T>(`${PLANNING}${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    // A quarter is built with the office's rules as the plan holds them, for the
    // technicians and from the first day the coordinator chose when asked.
    build: useMutation({
      mutationFn: (input: PlanBuildInput) => post<{ planId: string; routing: PlanRoutingSummary }>('/quarters', input),
      onSuccess: refresh,
    }),
    importOfficeDetails: useMutation({
      mutationFn: ({ planId, rows }: { planId: string; rows: OfficeSheetRow[] }) =>
        post<OfficeDetailsImport>(`/quarters/${planId}/office-details`, { rows }),
      onSuccess: refresh,
    }),
    // Re-reads every visit's filter sizes from the tenant report as it stands
    // now. A quarter's sizes are frozen when it is built, so a size the office
    // fills into Propertyware afterwards never reaches the visit on its own --
    // this is what carries it the last step, published visits included.
    refreshFilterSizes: useMutation({
      mutationFn: (planId: string) => post<FilterSizeRefresh>(`/quarters/${planId}/filter-sizes`),
      onSuccess: refresh,
    }),
    setType: useMutation({
      mutationFn: ({ stopId, inspectionType }: { stopId: string; inspectionType: PlanInspectionType }) =>
        post<{ id: string }>(`/stops/${stopId}/inspection-type`, { inspectionType }),
      onSuccess: refresh,
    }),
    // One visit's change, from its window. Its days are measured again on the
    // server, so days, stops and counts are all read again after.
    editStop: useMutation({
      mutationFn: ({ stopId, ...input }: PlanStopEdit & { stopId: string }) =>
        api<{ id: string; changed: string[] }>(`${PLANNING}/stops/${stopId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: refresh,
    }),
    exclude: useMutation({
      mutationFn: ({ stopId, reason }: { stopId: string; reason: string }) =>
        post<{ excluded: boolean; message?: string }>(`/stops/${stopId}/exclude`, { reason }),
      onSuccess: refresh,
    }),
    publish: useMutation({
      mutationFn: (planId: string) => post<PublishSummary>(`/quarters/${planId}/publish`),
      onSuccess: refresh,
    }),
    // What AI makes of the quarter. It changes nothing: the moves it proposes
    // are judged against the office's rules on the server, and applied only
    // when the office takes them.
    advice: useMutation({
      mutationFn: (planId: string) => post<PlanAdvice>(`/quarters/${planId}/advice`),
    }),
    applyAdvice: useMutation({
      mutationFn: ({ planId, moves }: { planId: string; moves: { stopId: string; toDate: string; toTechnicianId: string }[] }) =>
        post<{ applied: number; refused: RefusedMove[] }>(`/quarters/${planId}/advice/apply`, { moves }),
      onSuccess: refresh,
    }),
    // A day, or every day from today on, in the order that drives least from the
    // technician's home (the office, 2026-10-02). Only the order changes.
    optimizeDay: useMutation({
      mutationFn: ({ planId, dayId }: { planId: string; dayId: string }) =>
        post<{ days: OptimizedPlanDay[] }>(`/quarters/${planId}/days/${dayId}/optimize-route`),
      onSuccess: refresh,
    }),
    optimizeDays: useMutation({
      mutationFn: (planId: string) => post<{ days: OptimizedPlanDay[] }>(`/quarters/${planId}/optimize-routes`),
      onSuccess: refresh,
    }),
    // A visit clicked on the Days map joins the day picked: a booked one is
    // rescheduled, here and in Jobber, as the console reschedules one.
    moveToDay: useMutation({
      mutationFn: ({ planId, dayId, stopId }: { planId: string; dayId: string; stopId: string }) =>
        post<{ stopId: string; days: OptimizedPlanDay[] }>(`/quarters/${planId}/days/${dayId}/visits`, { stopId }),
      onSuccess: refresh,
    }),
    // A crowded day's visits to the Monday after, here and in Jobber, once the office confirmed them.
    moveToMonday: useMutation({
      mutationFn: ({ planId, ...input }: { planId: string; date: string; technicianId: string; inspectionIds: string[] }) =>
        post<{ monday: string; moved: number; failed: { inspectionId: string; message: string }[] }>(
          `/quarters/${planId}/late-move-outs/move`,
          input,
        ),
      onSuccess: refresh,
    }),
  };
}
