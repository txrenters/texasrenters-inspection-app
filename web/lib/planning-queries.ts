'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from './api';
import type { OfficeSheetRow } from './planning';

/**
 * The benefit-package plan API, for the plan page.
 *
 * Kept beside `queries.ts` rather than inside it: one page reads these, and
 * they change with the planner rather than with the rest of the console.
 */

const PLANNING = '/api/v1/admin/planning';

export type PlanStatus = 'DRAFT' | 'PUBLISHING' | 'PUBLISHED' | 'PUBLISH_FAILED' | 'CANCELLED';
export type PlanStopStatus = 'PLANNED' | 'BLOCKED' | 'EXCLUDED' | 'PUBLISHED' | 'FAILED';
export type PlanInspectionType = 'OCCUPIED' | 'HVAC';

export interface PlanSettings {
  occupiedVisitMinutes: number;
  hvacVisitMinutes: number;
  maxOnSiteMinutes: number;
  maxDriveMinutes: number;
  holidays: string[];
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
}

export interface PlanStop {
  id: string;
  sequence: number;
  previousSequence: number | null;
  orderSource: 'PRIOR_QUARTER' | 'CARRIED_SKIP' | 'NEW_ENROLLMENT';
  zone: string | null;
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
  previousTechnician: { id: string; displayName: string | null } | null;
  propertywareUnit: { name: string } | null;
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
  /** What the drive limit counts: from home to the first property on a day routed from home, and between the properties. Never the drive home. */
  totalDriveSeconds: number | null;
  totalDriveMeters: number | null;
  /** From the technician's home to the first property, when the day was routed from home. Part of `totalDriveSeconds`. */
  homeDriveSeconds: number | null;
  homeDriveMeters: number | null;
  /** `HOME` when the day was routed from the technician's home; `FIRST_STOP` when there was none on file. */
  originKind: string;
  durationSource: 'GOOGLE_TRAFFIC_AWARE' | 'OSRM_FREE_FLOW' | 'HAVERSINE' | null;
  departureAssumedAt: string | null;
  stops: PlanDayStop[];
}

export interface PlanRoutingSummary {
  planId: string;
  placed: number;
  unplaced: { stopId: string; reason: string }[];
  days: number;
  repaired: number;
  durationSource: PlanDay['durationSource'];
  settings: PlanSettings;
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

/** Who has which zone in each week of the quarter (the office's crew, 2026-09-16). */
export interface PlanRotation {
  /** In the order the zones go round. */
  crew: { technicianId: string; displayName: string | null; hasHome: boolean }[];
  zones: string[];
  /** Zones nobody on the crew lives within the day's drive of. */
  outOfReach: string[];
  /** `weekOf` is the week's Monday, `YYYY-MM-DD`. */
  weeks: { weekOf: string; zones: { zone: string; technicianId: string }[] }[];
}

export interface PublishSummary {
  planId: string;
  published: number;
  adopted: number;
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
};

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

/** The road line through one day. Each draw is a Google call, so a drawn day is kept for the visit. */
export const usePlanDayRoute = (planId: string | undefined, dayId: string | undefined) =>
  useQuery({
    queryKey: planningKeys.dayRoute(planId ?? '', dayId ?? ''),
    queryFn: ({ signal }) => api<PlanDayRoute>(`${PLANNING}/quarters/${planId}/days/${dayId}/route`, { signal }),
    enabled: Boolean(planId && dayId),
    staleTime: Number.POSITIVE_INFINITY,
  });

export function usePlanningMutations() {
  const client = useQueryClient();
  // Every change here moves days, stops and counts together, so the whole plan
  // is read again rather than patched piecemeal.
  const refresh = () => void client.invalidateQueries({ queryKey: planningKeys.all });
  const post = <T>(path: string, body?: unknown) =>
    api<T>(`${PLANNING}${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    // A quarter is built with the office's rules as the plan holds them, so the
    // console sends only which quarter: there is nothing for a coordinator to set.
    build: useMutation({
      mutationFn: (input: { year: number; quarter: number }) =>
        post<{ planId: string; routing: PlanRoutingSummary }>('/quarters', input),
      onSuccess: refresh,
    }),
    importOfficeDetails: useMutation({
      mutationFn: ({ planId, rows }: { planId: string; rows: OfficeSheetRow[] }) =>
        post<OfficeDetailsImport>(`/quarters/${planId}/office-details`, { rows }),
      onSuccess: refresh,
    }),
    setType: useMutation({
      mutationFn: ({ stopId, inspectionType }: { stopId: string; inspectionType: PlanInspectionType }) =>
        post<{ id: string }>(`/stops/${stopId}/inspection-type`, { inspectionType }),
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
  };
}
