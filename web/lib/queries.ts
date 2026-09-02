'use client';

import type { VideoPlayback } from './playback';
import type {
  AccountDeletionPreflight,
  AccountDeletionResult,
  AdminAssignment,
  AdminAssignmentListItem,
  PropertyPosition,
  TechnicianAssignments,
  TechnicianRoute,
  TechnicianPosition,
  AdminAuditEvent,
  AdminBulkDeleteResult,
  AdminCharge,
  AdminChargeReport,
  AdminChargeRule,
  AdminDashboard,
  AdminDeleteResult,
  AdminEvidenceRequest,
  AdminFloorPlan,
  AdminFloorPlanExtractionJob,
  AdminFloorPlanExtractionStarted,
  AdminInspection,
  AdminInspectionArea,
  AdminInspectionComparison,
  AdminInspectionFinding,
  AdminInspectionMedia,
  AdminInspectionPets,
  AdminInspectionPhoto,
  AdminLease,
  AdminPortfolio,
  AdminProperty,
  AdminPropertyArea,
  AdminReportShare,
  AdminRole,
  AdminRoleSummary,
  AdminTechnician,
  AdminUnit,
  AdminUser,
  AdminUserDetail,
  AiProviderName,
  ApiClientRevocation,
  ApiClientSummary,
  ApiDocument,
  IssuedApiKey,
  AiSettings,
  AreaChecklistEntry,
  AreaEvidenceBundle,
  AreaEvidenceSummary,
  CreatedTechnicianAccount,
  CreatedUserAccount,
  MailDeliveryResult,
  MergeInspectionAreasResult,
  PermissionGroup,
  PropertywareSyncError,
  PropertywareSyncRun,
  ProviderReadiness,
  JobberConnection,
  JobberPropertyLink,
  JobberSyncResult,
  JobberVisitImport,
} from '@texasrenters/shared';
import { allPropertywareEntities } from '@texasrenters/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api, type Page, queryString } from './api';
import {
  beginEntityOperation,
  cancelAffectedQueries,
  clearEntityOperation,
  completeEntityDeletion,
  completeEntityOperation,
  createOperationId,
  failEntityOperation,
  insertEntityIntoList,
  mergeAuthoritativeEntity,
  patchEntityById,
  patchEntityInQueries,
  removeEntityFromQueries,
  replaceTemporaryEntity,
  snapshotEntity,
  verifyAffectedQueries,
} from './state-consistency';

export const keys = {
  all: ['admin'] as const,
  dashboard: ['admin', 'dashboard'] as const,
  portfoliosRoot: ['admin', 'portfolios'] as const,
  portfolios: (search: string) => ['admin', 'portfolios', search] as const,
  propertiesRoot: ['admin', 'properties'] as const,
  propertyOptions: (portfolioId: string, search: string) =>
    ['admin', 'property-options', portfolioId, search] as const,
  properties: (query: object) => ['admin', 'properties', query] as const,
  property: (id: string) => ['admin', 'property', id] as const,
  floorPlans: (id: string) => ['admin', 'property', id, 'floor-plans'] as const,
  propertyAreas: (id: string) => ['admin', 'property', id, 'areas'] as const,
  units: (id: string) => ['admin', 'units', id] as const,
  leases: (id: string) => ['admin', 'leases', id] as const,
  inspectionsRoot: ['admin', 'inspections'] as const,
  inspections: (query: object) => ['admin', 'inspections', query] as const,
  inspection: (id: string) => ['admin', 'inspection', id] as const,
  inspectionAudit: (id: string, page: number) =>
    ['admin', 'inspection', id, 'audit', page] as const,
  inspectionMedia: (id: string) => ['admin', 'inspection', id, 'media'] as const,
  inspectionPhotos: (id: string) => ['admin', 'inspection', id, 'photos'] as const,
  /**
   * Area-first evidence. One summary per inspection, one bundle per area, so an
   * opened area caches independently and switching back is instant.
   */
  areaEvidenceSummary: (id: string) => ['admin', 'inspection', id, 'area-evidence'] as const,
  areaEvidence: (id: string, areaId: string) =>
    ['admin', 'inspection', id, 'area-evidence', areaId] as const,
  inspectionAreas: (id: string) => ['admin', 'inspection', id, 'areas'] as const,
  evidenceRequests: (id: string) => ['admin', 'inspection', id, 'evidence-requests'] as const,
  inspectionComparison: (id: string) => ['admin', 'inspection', id, 'comparison'] as const,
  inspectionPets: (id: string) => ['admin', 'inspection', id, 'pets'] as const,
  inspectionCharges: (id: string) => ['admin', 'inspection', id, 'charges'] as const,
  chargeReport: (id: string) => ['admin', 'inspection', id, 'charge-report'] as const,
  chargeRules: ['admin', 'charge-rules'] as const,
  reportShares: (id: string) => ['admin', 'inspection', id, 'report-shares'] as const,
  inspectionFindings: (id: string, page: number, reviewStatus: string, kind = 'ALL') =>
    ['admin', 'inspection', id, 'findings', page, reviewStatus, kind] as const,
  technicianLocations: ['technician-locations'] as const,
  propertyLocations: ['property-locations'] as const,
  technicianRoute: (id: string, date: string) => ['technician-route', id, date] as const,
  mapAssignments: (date: string) => ['map-assignments', date] as const,
  assignmentsRoot: ['admin', 'assignments'] as const,
  assignments: (query: object) => ['admin', 'assignments', query] as const,
  techniciansRoot: ['admin', 'technicians'] as const,
  technicians: (query: object) => ['admin', 'technicians', query] as const,
  technician: (id: string) => ['admin', 'technician', id] as const,
  usersRoot: ['admin', 'access', 'users'] as const,
  videoPlayback: (mediaId: string) => ['admin', 'video-playback', mediaId] as const,
  accountDeletionPreflight: (scope: string, id: string) =>
    ['admin', 'account-deletion-preflight', scope, id] as const,
  users: (query: object) => ['admin', 'access', 'users', query] as const,
  user: (id: string) => ['admin', 'access', 'user', id] as const,
  rolesRoot: ['admin', 'access', 'roles'] as const,
  roles: (query: object) => ['admin', 'access', 'roles', query] as const,
  role: (id: string) => ['admin', 'access', 'role', id] as const,
  permissionCatalog: ['admin', 'access', 'permissions'] as const,
  propertyware: ['admin', 'propertyware'] as const,
  propertywareSchedule: ['admin', 'propertyware', 'schedule'] as const,
  syncRuns: ['admin', 'propertyware', 'runs'] as const,
  syncErrors: (runId: string, page: number) =>
    ['admin', 'propertyware', 'runs', runId, 'errors', page] as const,
  providers: ['admin', 'providers'] as const,
  jobber: ['admin', 'jobber'] as const,
  jobberQueue: ['admin', 'jobber', 'queue'] as const,
  jobberVisitImports: ['admin', 'jobber', 'visit-imports'] as const,
  aiSettings: ['admin', 'ai-settings'] as const,
  openApiDocument: ['admin', 'system', 'openapi'] as const,
  apiClientsRoot: ['admin', 'api-clients'] as const,
  apiClients: (query: object) => ['admin', 'api-clients', query] as const,
};

export const useDashboard = () =>
  useQuery({
    queryKey: keys.dashboard,
    queryFn: ({ signal }) => api<AdminDashboard>('/api/v1/admin/dashboard', { signal }),
  });
export const usePortfolios = (search = '') =>
  useInfiniteQuery({
    queryKey: keys.portfolios(search),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api<Page<AdminPortfolio>>(
        `/api/v1/admin/portfolios${queryString({ page: pageParam, pageSize: 10, search })}`,
        { signal },
      ),
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
  });
export const useProperties = (
  query: Record<string, string | number | boolean | undefined>,
  enabled = true,
) =>
  useQuery({
    queryKey: keys.properties(query),
    queryFn: ({ signal }) =>
      api<Page<AdminProperty>>(`/api/v1/admin/properties${queryString(query)}`, { signal }),
    enabled,
    placeholderData: keepPreviousData,
  });
/**
 * Property options, optionally narrowed to one portfolio.
 *
 * `portfolioId` is deliberately optional: an empty value is dropped by
 * `queryString`, so the request returns every active property. Scheduling
 * starts from the address a coordinator was given, and requiring them to first
 * recall which portfolio owns it inverted the order they actually work in.
 */
export const usePropertyOptions = (portfolioId: string, search = '') =>
  useInfiniteQuery({
    queryKey: keys.propertyOptions(portfolioId, search),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      api<Page<AdminProperty>>(
        `/api/v1/admin/properties${queryString({
          page: pageParam,
          pageSize: 10,
          portfolioId,
          active: true,
          search,
        })}`,
        { signal },
      ),
    getNextPageParam: (lastPage) =>
      lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
  });
export const useProperty = (id: string) =>
  useQuery({
    queryKey: keys.property(id),
    queryFn: ({ signal }) => api<AdminProperty>(`/api/v1/admin/properties/${id}`, { signal }),
    enabled: Boolean(id),
  });
export const useUnits = (id: string) =>
  useQuery({
    queryKey: keys.units(id),
    queryFn: ({ signal }) =>
      api<Page<AdminUnit>>(`/api/v1/admin/properties/${id}/units?page=1&pageSize=100`, { signal }),
    enabled: Boolean(id),
  });
export const useFloorPlans = (id: string) =>
  useQuery({
    queryKey: keys.floorPlans(id),
    queryFn: ({ signal }) =>
      api<AdminFloorPlan[]>(`/api/v1/admin/properties/${id}/floor-plans`, { signal }),
    enabled: Boolean(id),
  });
export const usePropertyAreas = (id: string) =>
  useQuery({
    queryKey: keys.propertyAreas(id),
    queryFn: ({ signal }) =>
      api<AdminPropertyArea[]>(`/api/v1/admin/properties/${id}/areas`, { signal }),
    enabled: Boolean(id),
  });
export const useLeases = (id: string) =>
  useQuery({
    queryKey: keys.leases(id),
    queryFn: ({ signal }) =>
      api<Page<AdminLease>>(`/api/v1/admin/units/${id}/leases?page=1&pageSize=100`, { signal }),
    enabled: Boolean(id),
  });
export const useInspections = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.inspections(query),
    queryFn: ({ signal }) =>
      api<Page<AdminInspection>>(`/api/v1/admin/inspections${queryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
  });
export const useInspection = (id: string) =>
  useQuery({
    queryKey: keys.inspection(id),
    queryFn: ({ signal }) => api<AdminInspection>(`/api/v1/admin/inspections/${id}`, { signal }),
    enabled: Boolean(id),
  });
export const useInspectionAudit = (id: string, page: number) =>
  useQuery({
    queryKey: keys.inspectionAudit(id, page),
    queryFn: ({ signal }) =>
      api<Page<AdminAuditEvent>>(
        `/api/v1/admin/inspections/${id}/audit${queryString({ page, pageSize: 20 })}`,
        { signal },
      ),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
export const useInspectionMedia = (id: string) =>
  useQuery({
    queryKey: keys.inspectionMedia(id),
    queryFn: ({ signal }) =>
      api<AdminInspectionMedia[]>(`/api/v1/admin/inspections/${id}/media`, { signal }),
    enabled: Boolean(id),
  });
export const useInspectionPhotos = (id: string) =>
  useQuery({
    queryKey: keys.inspectionPhotos(id),
    queryFn: ({ signal }) =>
      api<AdminInspectionPhoto[]>(`/api/v1/admin/inspections/${id}/photos`, { signal }),
    enabled: Boolean(id),
  });
export const useInspectionFindings = (
  id: string,
  page: number,
  reviewStatus = '',
  kind: 'ALL' | 'DEFECTS' | 'SUMMARIES' = 'ALL',
  enabled = true,
) =>
  useQuery({
    queryKey: keys.inspectionFindings(id, page, reviewStatus, kind),
    queryFn: ({ signal }) =>
      api<Page<AdminInspectionFinding>>(
        `/api/v1/admin/inspections/${id}/findings${queryString({
          page,
          pageSize: 20,
          reviewStatus: reviewStatus || undefined,
          kind: kind === 'ALL' ? undefined : kind,
        })}`,
        { signal },
      ),
    enabled: Boolean(id) && enabled,
    placeholderData: keepPreviousData,
  });
/** Compact area index: counts and status only, no media. */
/** Evidence the office has asked the technician to go back and capture. */
export const useEvidenceRequests = (id: string) =>
  useQuery({
    queryKey: keys.evidenceRequests(id),
    queryFn: ({ signal }) =>
      api<AdminEvidenceRequest[]>(`/api/v1/admin/inspections/${id}/evidence-requests`, { signal }),
    enabled: Boolean(id),
  });

export const useAreaEvidenceSummary = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.areaEvidenceSummary(id),
    queryFn: ({ signal }) =>
      api<AreaEvidenceSummary>(`/api/v1/admin/inspections/${id}/area-evidence-summary`, { signal }),
    enabled: Boolean(id) && enabled,
  });

/**
 * Evidence for the one open area. Cached per area id, so returning to a
 * previously opened area is served from cache instead of refetching, and a
 * slow response for one area can never paint over another.
 */
export const useAreaEvidence = (id: string, areaId: string | null) =>
  useQuery({
    queryKey: keys.areaEvidence(id, areaId ?? ''),
    queryFn: ({ signal }) =>
      api<AreaEvidenceBundle>(`/api/v1/admin/inspections/${id}/areas/${areaId}/evidence`, {
        signal,
      }),
    enabled: Boolean(id) && Boolean(areaId),
  });

/**
 * Records how one checklist item was found, during review.
 *
 * PUT with the item's complete assessment, so clearing a control clears it on
 * the server rather than leaving a value the report would still print.
 *
 * The area's evidence is refetched rather than patched in place: the assessment
 * is one of the inputs to the area's derived review status, and reconstructing
 * that here would duplicate a rule the server owns.
 */
export const useRecordChecklistItem = (inspectionId: string, areaId: string | null) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      ...assessment
    }: {
      itemId: string;
      isClean: boolean | null;
      isUndamaged: boolean | null;
      isWorking: boolean | null;
      comment?: string | null;
    }) =>
      api<AreaChecklistEntry>(
        `/api/v1/admin/inspections/${inspectionId}/areas/${areaId}/checklist/${itemId}`,
        { method: 'PUT', body: JSON.stringify(assessment) },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.areaEvidence(inspectionId, areaId ?? '') });
      void client.invalidateQueries({ queryKey: keys.areaEvidenceSummary(inspectionId) });
    },
  });
};

export const useReportShares = (id: string) =>
  useQuery({
    queryKey: keys.reportShares(id),
    queryFn: ({ signal }) =>
      api<AdminReportShare[]>(`/api/v1/admin/inspections/${id}/report-shares`, { signal }),
    enabled: Boolean(id),
  });
export const useInspectionAreas = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.inspectionAreas(id),
    queryFn: ({ signal }) =>
      api<AdminInspectionArea[]>(`/api/v1/admin/inspections/${id}/areas`, { signal }),
    enabled: Boolean(id) && enabled,
  });
export const useInspectionComparison = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.inspectionComparison(id),
    queryFn: ({ signal }) =>
      api<AdminInspectionComparison | null>(`/api/v1/admin/inspections/${id}/comparison`, {
        signal,
      }),
    enabled: Boolean(id) && enabled,
  });
export const useInspectionPets = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.inspectionPets(id),
    queryFn: ({ signal }) =>
      api<AdminInspectionPets>(`/api/v1/admin/inspections/${id}/pets`, { signal }),
    enabled: Boolean(id) && enabled,
  });
export const useInspectionCharges = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.inspectionCharges(id),
    queryFn: ({ signal }) =>
      api<AdminCharge[]>(`/api/v1/admin/inspections/${id}/charges`, { signal }),
    enabled: Boolean(id) && enabled,
  });
export const useChargeReport = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.chargeReport(id),
    queryFn: ({ signal }) =>
      api<AdminChargeReport>(`/api/v1/admin/inspections/${id}/charge-report`, { signal }),
    enabled: Boolean(id) && enabled,
  });
export const useChargeRules = (enabled = true) =>
  useQuery({
    queryKey: keys.chargeRules,
    queryFn: ({ signal }) => api<AdminChargeRule[]>('/api/v1/admin/charge-rules', { signal }),
    enabled,
  });
/**
 * Every technician's last known position.
 *
 * Polled rather than pushed, for now. The realtime gateway could broadcast
 * these — the console already holds that socket — but that is the live-movement
 * stage; a minute-old view of where everyone is answers the question this page
 * exists for, and polling cannot get stuck in a state a reconnect has to fix.
 */
export const useTechnicianLocations = (enabled = true) =>
  useQuery({
    queryKey: keys.technicianLocations,
    queryFn: ({ signal }) =>
      api<TechnicianPosition[]>('/api/v1/admin/technician-locations', { signal }),
    // A safety net, not the mechanism. Positions arrive over the socket now
    // (`technician:position`), so this exists only for the case the socket has
    // quietly gone away — which looks identical to nobody moving, and would
    // otherwise leave the map confidently wrong for as long as it stayed open.
    refetchInterval: 5 * 60_000,
    enabled,
  });
/**
 * Where the properties are.
 *
 * No refetch interval, unlike the technician positions beside it: a building
 * does not move. New rows appear only when the sync adds a property and the
 * geocoder places it, which is hours of work at the fastest — so this is
 * fetched once and left alone.
 */
export const usePropertyLocations = (enabled = true) =>
  useQuery({
    queryKey: keys.propertyLocations,
    queryFn: ({ signal }) => api<PropertyPosition[]>('/api/v1/admin/property-locations', { signal }),
    staleTime: 30 * 60_000,
    enabled,
  });
/**
 * A technician's day, ordered from where they are now.
 *
 * Refetched on an interval because the route starts at a live position: as the
 * technician drives, the remaining order and the times change. Slower than the
 * position feed itself, because re-ordering the same stops every few seconds
 * would make the panel restless without telling anybody anything new.
 */
/**
 * Who is working today and which properties are theirs.
 *
 * Refetched slowly. Assignments change when the office moves work, not minute
 * to minute — unlike positions, which arrive over the socket. Polling this at
 * the same rate would spend requests to be told the same roster.
 */
export const useMapAssignments = (date: string, enabled = true) =>
  useQuery({
    queryKey: keys.mapAssignments(date),
    queryFn: ({ signal }) =>
      api<TechnicianAssignments[]>(`/api/v1/admin/map/assignments${queryString({ date })}`, {
        signal,
      }),
    refetchInterval: 5 * 60_000,
    enabled,
  });
export const useTechnicianRoute = (id: string, date: string, enabled = true) =>
  useQuery({
    queryKey: keys.technicianRoute(id, date),
    queryFn: ({ signal }) =>
      api<TechnicianRoute>(
        `/api/v1/admin/technicians/${id}/route${queryString({ date })}`,
        { signal },
      ),
    refetchInterval: 2 * 60_000,
    enabled,
  });
export const useAssignments = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.assignments(query),
    queryFn: ({ signal }) =>
      api<Page<AdminAssignmentListItem>>(`/api/v1/admin/assignments${queryString(query)}`, {
        signal,
      }),
    placeholderData: keepPreviousData,
  });
/**
 * Refetched on a timer because these rows carry presence.
 *
 * Everything else here is fine being a minute stale; "is this person online
 * right now" is not, and a dot that goes on claiming someone is connected long
 * after they left is worse than no dot. Thirty seconds is the coarsest interval
 * at which the answer still means "now"; `refetchIntervalInBackground` is left
 * off, so a console nobody is looking at stops asking.
 */
const PRESENCE_REFRESH_MS = 30_000;

export const useTechnicians = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.technicians(query),
    queryFn: ({ signal }) =>
      api<Page<AdminTechnician>>(`/api/v1/admin/technicians${queryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: PRESENCE_REFRESH_MS,
  });
export const useTechnician = (id: string) =>
  useQuery({
    queryKey: keys.technician(id),
    queryFn: ({ signal }) => api<AdminTechnician>(`/api/v1/admin/technicians/${id}`, { signal }),
    enabled: Boolean(id),
  });
export const useUsers = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.users(query),
    queryFn: ({ signal }) =>
      api<Page<AdminUser>>(`/api/v1/admin/access/users${queryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: PRESENCE_REFRESH_MS,
  });
export const useUser = (id: string) =>
  useQuery({
    queryKey: keys.user(id),
    queryFn: ({ signal }) => api<AdminUserDetail>(`/api/v1/admin/access/users/${id}`, { signal }),
    enabled: Boolean(id),
  });
/**
 * What deleting an account would cost, fetched only once the confirmation is
 * open.
 *
 * Deliberately not cached with the account itself: it counts live inspection
 * records, and a stale answer here would either hide a blocker or promise to
 * release inspections that have since been reassigned. `staleTime: 0` so
 * reopening the dialog asks again.
 */
export const useAccountDeletionPreflight = (
  scope: 'CONSOLE' | 'TECHNICIAN',
  id: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: keys.accountDeletionPreflight(scope, id),
    queryFn: ({ signal }) =>
      api<AccountDeletionPreflight>(
        scope === 'TECHNICIAN'
          ? `/api/v1/admin/technicians/${id}/deletion-preflight`
          : `/api/v1/admin/access/users/${id}/deletion-preflight`,
        { signal },
      ),
    enabled: enabled && Boolean(id),
    staleTime: 0,
    gcTime: 0,
  });
/**
 * A short-lived signed playback URL for one recording.
 *
 * Fetched only when a viewer actually opens the recording — a signed token is
 * minted per request, so requesting one for every thumbnail on an area page
 * would mint dozens nobody uses.
 *
 * `staleTime` sits under the token's own lifetime so react-query re-requests
 * before it lapses rather than handing the player a dead URL mid-recording.
 */
export const useVideoPlayback = (mediaId: string, enabled = true) =>
  useQuery({
    queryKey: keys.videoPlayback(mediaId),
    queryFn: ({ signal }) =>
      api<VideoPlayback>(`/api/v1/inspection-videos/${mediaId}/playback`, { signal }),
    enabled: enabled && Boolean(mediaId),
    staleTime: 60 * 60_000,
    // Never persisted: a stored playback token would outlive its expiry.
    gcTime: 0,
    retry: 1,
  });
export const useRoles = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.roles(query),
    queryFn: ({ signal }) =>
      api<Page<AdminRoleSummary>>(`/api/v1/admin/access/roles${queryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
  });
export const useRole = (id: string) =>
  useQuery({
    queryKey: keys.role(id),
    queryFn: ({ signal }) => api<AdminRole>(`/api/v1/admin/access/roles/${id}`, { signal }),
    enabled: Boolean(id),
  });
export const usePermissionCatalog = () =>
  useQuery({
    queryKey: keys.permissionCatalog,
    queryFn: ({ signal }) =>
      api<{ groups: PermissionGroup[]; keys: string[] }>('/api/v1/admin/access/permissions', {
        signal,
      }),
    staleTime: 10 * 60 * 1000,
  });
export interface PropertywareSchedule {
  enabled: boolean;
  organizationConfigured: boolean;
  jobs: Array<{
    mode: 'incremental' | 'reconciliation';
    cron: string | null;
    scheduled: boolean;
    nextRunAt: string | null;
  }>;
}
export const useSyncSchedule = () =>
  useQuery({
    queryKey: keys.propertywareSchedule,
    queryFn: ({ signal }) =>
      api<PropertywareSchedule>('/api/v1/admin/integrations/propertyware/schedule', { signal }),
  });
export const usePropertywareStatus = () =>
  useQuery({
    queryKey: keys.propertyware,
    queryFn: ({ signal }) =>
      api<Record<string, unknown>>('/api/v1/admin/integrations/propertyware/status', { signal }),
    refetchInterval: (query) => {
      const status = (query.state.data as { lastRun?: { status?: string } } | undefined)?.lastRun
        ?.status;
      // Keep polling while a run is actively pending or running so the live
      // indicator resolves on its own.
      return status === 'RUNNING' || status === 'PENDING' ? 5_000 : false;
    },
  });
export const useSyncRuns = () =>
  useQuery({
    queryKey: keys.syncRuns,
    queryFn: ({ signal }) =>
      api<Page<PropertywareSyncRun>>(
        '/api/v1/admin/integrations/propertyware/sync-runs?page=1&pageSize=25',
        { signal },
      ),
    select: (data) => data.items,
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => run.status === 'RUNNING' || run.status === 'PENDING')
        ? 5_000
        : false,
  });
export const useSyncErrors = (runId: string, page: number) =>
  useQuery({
    queryKey: keys.syncErrors(runId, page),
    queryFn: ({ signal }) =>
      api<Page<PropertywareSyncError>>(
        `/api/v1/admin/integrations/propertyware/sync-runs/${runId}/errors${queryString({
          page,
          pageSize: 25,
        })}`,
        { signal },
      ),
    enabled: Boolean(runId),
    placeholderData: keepPreviousData,
  });
const JOBBER = '/api/v1/admin/integrations/jobber';

/**
 * Jobber connection and background-schedule state.
 *
 * Polled on two different clocks. While a run is in flight the page is showing
 * live progress, so it follows closely; the rest of the time it only has to
 * notice that a scheduled run happened, and the schedule itself is a countdown
 * the client can tick on its own without asking the server.
 */
export const useJobberConnection = () =>
  useQuery({
    queryKey: keys.jobber,
    queryFn: ({ signal }) => api<JobberConnection>(`${JOBBER}/connection`, { signal }),
    refetchInterval: (query) => (query.state.data?.syncInProgress ? 2_000 : 30_000),
  });

/**
 * Jobber properties waiting on a person.
 *
 * Polled while the page is open: the sync runs on its own schedule, so a queue
 * left open would otherwise show a snapshot from whenever it was loaded and
 * quietly hide work that arrived since.
 */
export const useJobberQueue = () =>
  useQuery({
    queryKey: keys.jobberQueue,
    queryFn: ({ signal }) =>
      api<JobberPropertyLink[]>(`${JOBBER}/property-links/queue?limit=100`, { signal }),
    refetchInterval: 60_000,
  });

export const useJobberVisitImports = () =>
  useQuery({
    queryKey: keys.jobberVisitImports,
    queryFn: ({ signal }) =>
      api<JobberVisitImport[]>(`${JOBBER}/visit-imports?limit=100`, { signal }),
    refetchInterval: 60_000,
  });

export function useJobberMutations() {
  const client = useQueryClient();
  // Linking a property releases the visits held behind it, so the visit list is
  // as stale as the queue after every one of these.
  const refresh = () =>
    void verifyAffectedQueries(client, [
      keys.jobber,
      keys.jobberQueue,
      keys.jobberVisitImports,
      keys.inspectionsRoot,
    ]);
  return {
    authorize: useMutation({
      mutationFn: () =>
        api<{ authorizationUrl: string }>(`${JOBBER}/oauth/authorize`, { method: 'POST' }),
    }),
    disconnect: useMutation({
      mutationFn: () => api<unknown>(`${JOBBER}/disconnect`, { method: 'POST' }),
      onSuccess: refresh,
    }),
    sync: useMutation({
      mutationFn: () => api<JobberSyncResult>(`${JOBBER}/sync`, { method: 'POST' }),
      onSuccess: refresh,
    }),
    link: useMutation({
      mutationFn: (input: {
        linkId: string;
        buildingId: string;
        unitId?: string;
        leaseId?: string;
      }) =>
        api<{ id: string; releasedVisits: number }>(
          `${JOBBER}/property-links/${input.linkId}/link`,
          {
            method: 'POST',
            body: JSON.stringify({
              buildingId: input.buildingId,
              unitId: input.unitId,
              leaseId: input.leaseId,
            }),
          },
        ),
      onSuccess: refresh,
    }),
    ignore: useMutation({
      mutationFn: (input: { linkId: string; reason?: string }) =>
        api<unknown>(`${JOBBER}/property-links/${input.linkId}/ignore`, {
          method: 'POST',
          body: JSON.stringify({ reason: input.reason }),
        }),
      onSuccess: refresh,
    }),
  };
}

export const useProviders = () =>
  useQuery({
    queryKey: keys.providers,
    queryFn: ({ signal }) =>
      api<{ providers: ProviderReadiness[]; checkedAt: string }>(
        '/api/v1/admin/integrations/providers/status',
        { signal },
      ),
  });

export const useTestMail = () =>
  useMutation({
    mutationFn: (recipientEmail: string) =>
      api<MailDeliveryResult>('/api/v1/admin/integrations/mail/test', {
        method: 'POST',
        body: JSON.stringify({ recipientEmail }),
      }),
  });

export const useAiSettings = () =>
  useQuery({
    queryKey: keys.aiSettings,
    queryFn: ({ signal }) => api<AiSettings>('/api/v1/admin/ai/settings', { signal }),
  });

export function useAiSettingsMutations() {
  const client = useQueryClient();
  const refresh = (data: AiSettings) => client.setQueryData(keys.aiSettings, data);
  return {
    setActiveProvider: useMutation({
      mutationFn: (activeProvider: AiProviderName) =>
        api<AiSettings>('/api/v1/admin/ai/settings/routing', {
          method: 'PATCH',
          body: JSON.stringify({ activeProvider }),
        }),
      onSuccess: refresh,
    }),
    updateProvider: useMutation({
      mutationFn: ({
        provider,
        modelId,
        apiKey,
        clearApiKey,
        monthlyTokenBudget,
      }: {
        provider: AiProviderName;
        modelId: string;
        apiKey?: string;
        clearApiKey?: boolean;
        monthlyTokenBudget?: number | null;
      }) =>
        api<AiSettings>(`/api/v1/admin/ai/providers/${provider}`, {
          method: 'PATCH',
          body: JSON.stringify({ modelId, apiKey, clearApiKey, monthlyTokenBudget }),
        }),
      onSuccess: refresh,
    }),
    validateProvider: useMutation({
      mutationFn: (provider: AiProviderName) =>
        api<AiSettings>(`/api/v1/admin/ai/providers/${provider}/validate`, {
          method: 'POST',
        }),
      onSuccess: refresh,
    }),
  };
}

export function useAccessMutations() {
  const client = useQueryClient();
  const refreshUsers = (id?: string) => {
    void verifyAffectedQueries(client, [keys.usersRoot, ...(id ? [keys.user(id)] : [])]);
  };
  const refreshRoles = (id?: string) => {
    void verifyAffectedQueries(client, [keys.rolesRoot, ...(id ? [keys.role(id)] : [])]);
  };
  return {
    /**
     * Let this console user onto the handset as well.
     *
     * The mirror of `grantTechnicianConsoleAccess`. Refreshes the technician
     * roster too, because that is the list they have just joined.
     */
    grantTechnicianAccess: useMutation({
      mutationFn: (userId: string) =>
        api<{ id: string; email: string; granted: boolean }>(
          `/api/v1/admin/access/users/${userId}/technician-access`,
          { method: 'POST' },
        ),
      onSuccess: (_data, userId) => {
        refreshUsers(userId);
        void verifyAffectedQueries(client, [keys.techniciansRoot]);
      },
    }),
    createUser: useMutation({
      mutationFn: (input: { email: string; displayName: string; roleIds: string[] }) =>
        api<CreatedUserAccount>('/api/v1/admin/access/users', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshUsers(data.id);
      },
    }),
    updateUserStatus: useMutation({
      mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
        api<AdminUserDetail>(`/api/v1/admin/access/users/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive }),
        }),
      onMutate: async (variables) => {
        await cancelAffectedQueries(client, [keys.usersRoot, keys.user(variables.id)]);
        const previous = snapshotEntity<AdminUserDetail>(client, keys.usersRoot, variables.id);
        const operationId = beginEntityOperation(variables.id, 'UPDATING', {
          isActive: variables.isActive,
        });
        patchEntityById(
          client,
          keys.all,
          variables.id,
          { isActive: variables.isActive },
          {
            state: 'UPDATING',
            operationId,
          },
        );
        return { operationId, previous };
      },
      onSuccess: (data, variables, context) => {
        if (!context || !completeEntityOperation(variables.id, context.operationId, data)) return;
        patchEntityInQueries(client, keys.all, data);
        refreshUsers(variables.id);
      },
      onError: (_error, variables, context) => {
        if (!context) return;
        failEntityOperation(variables.id, context.operationId);
        if (context.previous) patchEntityInQueries(client, keys.all, context.previous);
        else refreshUsers(variables.id);
      },
    }),
    setUserRoles: useMutation({
      mutationFn: ({ id, roleIds }: { id: string; roleIds: string[] }) =>
        api<AdminUserDetail>(`/api/v1/admin/access/users/${id}/roles`, {
          method: 'PUT',
          body: JSON.stringify({ roleIds }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshUsers(variables.id);
      },
    }),
    createRole: useMutation({
      mutationFn: (input: { name: string; description?: string; permissions: string[] }) =>
        api<AdminRoleSummary>('/api/v1/admin/access/roles', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshRoles(data.id);
      },
    }),
    updateRole: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        name?: string;
        description?: string;
        permissions?: string[];
      }) =>
        api<AdminRoleSummary>(`/api/v1/admin/access/roles/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshRoles(variables.id);
      },
    }),
    deleteRole: useMutation({
      mutationFn: (id: string) =>
        api<AdminDeleteResult>(`/api/v1/admin/access/roles/${id}`, { method: 'DELETE' }),
      onMutate: async (id) => {
        await cancelAffectedQueries(client, [keys.rolesRoot, keys.role(id)]);
        const operationId = beginEntityOperation(id, 'DELETING');
        removeEntityFromQueries(client, keys.rolesRoot, id);
        return { operationId };
      },
      onSuccess: (_data, id, context) => {
        if (context) completeEntityDeletion(id, context.operationId);
        refreshRoles();
      },
      onError: (_error, id, context) => {
        if (context) failEntityOperation(id, context.operationId);
        refreshRoles(id);
      },
    }),
    /**
     * Deleting a web user also frees any inspections assigned to them, so the
     * assignment and dashboard views are refreshed alongside the user list.
     */
    deleteUser: useMutation({
      mutationFn: (id: string) =>
        api<AccountDeletionResult>(`/api/v1/admin/access/users/${id}`, { method: 'DELETE' }),
      onMutate: async (id) => {
        await cancelAffectedQueries(client, [keys.usersRoot, keys.user(id)]);
        const operationId = beginEntityOperation(id, 'DELETING');
        removeEntityFromQueries(client, keys.usersRoot, id);
        return { operationId };
      },
      onSuccess: (_data, id, context) => {
        if (context) completeEntityDeletion(id, context.operationId);
        void verifyAffectedQueries(client, [
          keys.usersRoot,
          keys.rolesRoot,
          keys.assignmentsRoot,
          keys.inspectionsRoot,
          keys.dashboard,
        ]);
      },
      onError: (_error, id, context) => {
        if (context) failEntityOperation(id, context.operationId);
        void verifyAffectedQueries(client, [keys.usersRoot, keys.user(id)]);
      },
    }),
  };
}

export function useAdminMutations() {
  const client = useQueryClient();
  const refreshInspection = (id?: string) => {
    void verifyAffectedQueries(client, [
      keys.inspectionsRoot,
      keys.assignmentsRoot,
      keys.dashboard,
      ...(id ? [keys.inspection(id)] : []),
    ]);
  };
  // A workflow action (finalize / TBD / follow-up / merge) also changes the
  // audit trail and area list for the open inspection.
  const refreshWorkflow = (id: string) => {
    refreshInspection(id);
    void verifyAffectedQueries(client, [
      ['admin', 'inspection', id, 'audit'],
      keys.inspectionAreas(id),
    ]);
  };
  // A pet/charge action changes the pet review, charge list, and the report.
  const refreshCharges = (id: string) => {
    void verifyAffectedQueries(client, [
      keys.inspectionPets(id),
      keys.inspectionCharges(id),
      keys.chargeReport(id),
    ]);
  };
  const refreshFloorPlan = (propertyId: string) => {
    void verifyAffectedQueries(client, [
      keys.floorPlans(propertyId),
      keys.propertyAreas(propertyId),
    ]);
  };
  return {
    uploadFloorPlan: useMutation({
      mutationFn: ({
        propertyId,
        file,
        unitId,
      }: {
        propertyId: string;
        file: File;
        unitId?: string;
      }) => {
        const form = new FormData();
        form.set('file', file);
        if (unitId) form.set('unitId', unitId);
        return api<AdminFloorPlan>(`/api/v1/admin/properties/${propertyId}/floor-plans`, {
          method: 'POST',
          body: form,
        });
      },
      onSuccess: (data, variables) => {
        const current = client.getQueryData<AdminFloorPlan[]>(
          keys.floorPlans(variables.propertyId),
        );
        client.setQueryData(
          keys.floorPlans(variables.propertyId),
          current?.some((plan) => plan.id === data.id)
            ? current.map((plan) => (plan.id === data.id ? data : plan))
            : [data, ...(current ?? [])],
        );
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshFloorPlan(variables.propertyId);
      },
    }),
    /**
     * Starts extraction and resolves as soon as the job exists. The model call
     * runs on the server outside the request — it routinely outlives the HTTP
     * socket timeout — so the caller polls `floorPlanExtractionJob` until the
     * job settles rather than waiting on this response.
     */
    extractFloorPlan: useMutation({
      mutationFn: (variables: { propertyId: string; floorPlanId: string }) =>
        api<AdminFloorPlanExtractionStarted>(
          `/api/v1/admin/floor-plans/${variables.floorPlanId}/extract`,
          { method: 'POST' },
        ),
    }),
    floorPlanExtractionJob: (floorPlanId: string, jobId: string, signal?: AbortSignal) =>
      api<AdminFloorPlanExtractionJob>(
        `/api/v1/admin/floor-plans/${floorPlanId}/extraction-jobs/${jobId}`,
        { signal },
      ),
    createPropertyArea: useMutation({
      mutationFn: ({
        propertyId,
        ...input
      }: {
        propertyId: string;
        floorName: string;
        name: string;
        inspectionOrder: number;
        isRequired: boolean;
        unitId?: string;
      }) =>
        api<AdminPropertyArea>(`/api/v1/admin/properties/${propertyId}/areas`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const temporaryId = `client:area:${createOperationId('create-area')}`;
        const operationId = beginEntityOperation(temporaryId, 'CREATING');
        const optimistic = {
          id: temporaryId,
          propertyId: variables.propertyId,
          unitId: variables.unitId ?? null,
          unit: null,
          name: variables.name.trim(),
          inspectionOrder: variables.inspectionOrder,
          isRequired: variables.isRequired,
          status: 'DRAFT' as const,
          source: 'MANUAL',
          updatedAt: new Date().toISOString(),
          floor: {
            id: `client:floor:${variables.floorName.trim().toLowerCase()}`,
            name: variables.floorName.trim(),
            sortOrder: variables.inspectionOrder,
          },
          __sync: { state: 'CREATING' as const, operationId },
        };
        insertEntityIntoList(client, queryKey, optimistic);
        return { temporaryId, operationId };
      },
      onSuccess: (data, variables, context) => {
        if (context) {
          clearEntityOperation(context.temporaryId, context.operationId);
          replaceTemporaryEntity(
            client,
            keys.propertyAreas(variables.propertyId),
            context.temporaryId,
            data,
          );
        }
        const operationId = beginEntityOperation(data.id, 'CREATING', data);
        completeEntityOperation(data.id, operationId, data);
        patchEntityInQueries(client, keys.propertyAreas(variables.propertyId), data);
      },
      onError: (_error, variables, context) => {
        if (!context) return;
        failEntityOperation(context.temporaryId, context.operationId);
        removeEntityFromQueries(
          client,
          keys.propertyAreas(variables.propertyId),
          context.temporaryId,
        );
      },
      onSettled: (data, error, variables) => {
        if (!error && data)
          void verifyAffectedQueries(client, [
            keys.floorPlans(variables.propertyId),
            keys.propertyAreas(variables.propertyId),
          ]);
      },
    }),
    createFallbackPropertyArea: useMutation({
      mutationFn: ({ propertyId }: { propertyId: string }) =>
        api<AdminPropertyArea>(`/api/v1/admin/properties/${propertyId}/areas/fallback`, {
          method: 'POST',
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        const current =
          client.getQueryData<AdminPropertyArea[]>(keys.propertyAreas(variables.propertyId)) ?? [];
        if (!current.some((area) => area.id === data.id))
          client.setQueryData(keys.propertyAreas(variables.propertyId), [...current, data]);
        refreshFloorPlan(variables.propertyId);
      },
    }),
    updatePropertyArea: useMutation({
      mutationFn: (variables: {
        propertyId: string;
        areaId: string;
        floorName?: string;
        name?: string;
        inspectionOrder?: number;
        isRequired?: boolean;
        expectedUpdatedAt?: string;
      }) => {
        return api<AdminPropertyArea>(`/api/v1/admin/property-areas/${variables.areaId}`, {
          method: 'PATCH',
          /**
           * Listed field by field, so anything the editor sends that is not
           * named here is dropped in silence.
           *
           * `hasAirConditioning` was missing exactly that way, and the failure
           * had no symptom to follow: the form ticked, the request went out
           * without the field, the server answered 200 having changed nothing,
           * and the box was clear again on the next refetch. No console error,
           * no failed request — the one shape of bug this style of body
           * invites. That field is gone, the hazard is not.
           */
          body: JSON.stringify({
            floorName: variables.floorName,
            name: variables.name,
            inspectionOrder: variables.inspectionOrder,
            isRequired: variables.isRequired,
            expectedUpdatedAt: variables.expectedUpdatedAt,
          }),
        });
      },
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const previous = client
          .getQueryData<AdminPropertyArea[]>(queryKey)
          ?.find((area) => area.id === variables.areaId);
        const patch = {
          ...(variables.floorName
            ? {
                floor: {
                  id: previous?.floor?.id ?? `client:floor:${variables.floorName}`,
                  name: variables.floorName,
                  sortOrder: previous?.floor?.sortOrder ?? variables.inspectionOrder ?? 1,
                },
              }
            : {}),
          ...(variables.name ? { name: variables.name } : {}),
          ...(variables.inspectionOrder ? { inspectionOrder: variables.inspectionOrder } : {}),
          // `=== undefined` rather than a truthy check like the ones above:
          // false is a meaningful value, and a truthy test would make unticking
          // the box invisible until the refetch landed.
          ...(variables.isRequired === undefined ? {} : { isRequired: variables.isRequired }),
        };
        const operationId = beginEntityOperation(variables.areaId, 'UPDATING', patch);
        patchEntityById(client, queryKey, variables.areaId, patch, {
          state: 'UPDATING',
          operationId,
        });
        return { operationId, previous };
      },
      onSuccess: (data, variables, context) => {
        if (!context || !completeEntityOperation(data.id, context.operationId, data)) return;
        patchEntityInQueries(client, keys.propertyAreas(variables.propertyId), data);
      },
      onError: (_error, variables, context) => {
        if (!context || !failEntityOperation(variables.areaId, context.operationId)) return;
        if (context.previous)
          patchEntityInQueries(client, keys.propertyAreas(variables.propertyId), context.previous);
      },
      onSettled: (data, error, variables) => {
        if (!error && data) refreshFloorPlan(variables.propertyId);
      },
    }),
    deletePropertyArea: useMutation({
      mutationFn: (variables: { propertyId: string; areaId: string }) =>
        api<AdminDeleteResult>(`/api/v1/admin/property-areas/${variables.areaId}`, {
          method: 'DELETE',
        }),
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const previous = client
          .getQueryData<AdminPropertyArea[]>(queryKey)
          ?.find((area) => area.id === variables.areaId);
        const operationId = beginEntityOperation(variables.areaId, 'DELETING');
        removeEntityFromQueries(client, queryKey, variables.areaId);
        return { operationId, previous };
      },
      onSuccess: (data, _variables, context) => {
        if (context) completeEntityDeletion(data.id, context.operationId);
      },
      onError: (_error, variables, context) => {
        if (!context || !failEntityOperation(variables.areaId, context.operationId)) return;
        if (context.previous)
          insertEntityIntoList(client, keys.propertyAreas(variables.propertyId), context.previous);
      },
      onSettled: (data, error, variables) => {
        if (!error && data) refreshFloorPlan(variables.propertyId);
      },
    }),
    // Re-runs extraction to fill in coordinates for areas that have none. Adds
    // marker data only — never changes names, ordering, or approval status.
    retryMissingMarkers: useMutation({
      mutationFn: (variables: { propertyId: string; floorPlanId: string }) =>
        api<{ updated: number; unmatched: number }>(
          `/api/v1/admin/floor-plans/${variables.floorPlanId}/retry-missing-markers`,
          { method: 'POST' },
        ),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    // Marker placement/adjustment. Never changes area approval status; reuses the
    // floor-plan invalidator (floor-plans + property-areas only).
    updateAreaMarker: useMutation({
      mutationFn: (variables: {
        propertyId: string;
        areaId: string;
        x: number;
        y: number;
        pageNumber?: number;
        expectedUpdatedAt?: string;
      }) =>
        api<AdminPropertyArea>(`/api/v1/admin/property-areas/${variables.areaId}/marker`, {
          method: 'PATCH',
          body: JSON.stringify({
            x: variables.x,
            y: variables.y,
            ...(variables.pageNumber ? { pageNumber: variables.pageNumber } : {}),
            expectedUpdatedAt: variables.expectedUpdatedAt,
          }),
        }),
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const previous = client
          .getQueryData<AdminPropertyArea[]>(queryKey)
          ?.find((area) => area.id === variables.areaId);
        const marker = {
          available: true as const,
          x: variables.x,
          y: variables.y,
          source: previous?.marker ? 'ADMIN_ADJUSTED' : 'ADMIN_PLACED',
          confidence: null,
          updatedAt: new Date().toISOString(),
        };
        const operationId = beginEntityOperation(variables.areaId, 'UPDATING', { marker });
        patchEntityById(
          client,
          queryKey,
          variables.areaId,
          { marker },
          {
            state: 'UPDATING',
            operationId,
          },
        );
        return { operationId, previous };
      },
      onSuccess: (data, variables, context) => {
        if (!context || !completeEntityOperation(data.id, context.operationId, data)) return;
        patchEntityInQueries(client, keys.propertyAreas(variables.propertyId), data);
      },
      onError: (_error, variables, context) => {
        if (!context || !failEntityOperation(variables.areaId, context.operationId)) return;
        if (context.previous)
          patchEntityInQueries(client, keys.propertyAreas(variables.propertyId), context.previous);
      },
      onSettled: (data, error, variables) => {
        if (!error && data) refreshFloorPlan(variables.propertyId);
      },
    }),
    deletePropertyAreas: useMutation({
      mutationFn: ({ propertyId, areaIds }: { propertyId: string; areaIds: string[] }) =>
        api<AdminBulkDeleteResult>(`/api/v1/admin/properties/${propertyId}/areas/delete`, {
          method: 'POST',
          body: JSON.stringify({ areaIds }),
        }),
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const current = client.getQueryData<AdminPropertyArea[]>(queryKey) ?? [];
        const previous = current.filter((area) => variables.areaIds.includes(area.id));
        const operations = new Map(
          variables.areaIds.map((id) => [id, beginEntityOperation(id, 'DELETING')]),
        );
        for (const id of variables.areaIds) removeEntityFromQueries(client, queryKey, id);
        return { operations, previous };
      },
      onSuccess: (data, _variables, context) => {
        if (!context) return;
        for (const id of data.ids) {
          const operationId = context.operations.get(id);
          if (operationId) completeEntityDeletion(id, operationId);
        }
      },
      onError: (_error, variables, context) => {
        if (!context) return;
        for (const [id, operationId] of context.operations) {
          if (!failEntityOperation(id, operationId)) continue;
          const previous = context.previous.find((area) => area.id === id);
          if (previous)
            insertEntityIntoList(client, keys.propertyAreas(variables.propertyId), previous);
        }
      },
      onSettled: (data, error, variables) => {
        if (!error && data) refreshFloorPlan(variables.propertyId);
      },
    }),
    approvePropertyAreas: useMutation({
      mutationFn: ({ propertyId, areaIds }: { propertyId: string; areaIds: string[] }) =>
        api<AdminPropertyArea[]>(`/api/v1/admin/properties/${propertyId}/areas/approve`, {
          method: 'POST',
          body: JSON.stringify({ areaIds }),
        }),
      onMutate: async (variables) => {
        const queryKey = keys.propertyAreas(variables.propertyId);
        await cancelAffectedQueries(client, [queryKey]);
        const previous = client.getQueryData<AdminPropertyArea[]>(queryKey) ?? [];
        const operations = new Map<string, string>();
        for (const id of variables.areaIds) {
          const operationId = beginEntityOperation(id, 'PROCESSING');
          operations.set(id, operationId);
          patchEntityById(client, queryKey, id, {}, { state: 'PROCESSING', operationId });
        }
        return { operations, previous };
      },
      onSuccess: (data, variables, context) => {
        client.setQueryData(keys.propertyAreas(variables.propertyId), data);
        if (!context) return;
        for (const area of data) {
          const operationId = context.operations.get(area.id);
          if (operationId) completeEntityOperation(area.id, operationId, area);
        }
      },
      onError: (_error, variables, context) => {
        if (!context) return;
        for (const [id, operationId] of context.operations) failEntityOperation(id, operationId);
        client.setQueryData(keys.propertyAreas(variables.propertyId), context.previous);
      },
      onSettled: (data, error, variables) => {
        if (!error && data) refreshFloorPlan(variables.propertyId);
      },
    }),
    rejectPropertyArea: useMutation({
      mutationFn: (variables: { propertyId: string; areaId: string; reason?: string }) =>
        api<AdminPropertyArea>(`/api/v1/admin/property-areas/${variables.areaId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: variables.reason }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshFloorPlan(variables.propertyId);
      },
    }),
    archivePropertyArea: useMutation({
      mutationFn: (variables: { propertyId: string; areaId: string }) =>
        api<AdminPropertyArea>(`/api/v1/admin/property-areas/${variables.areaId}/archive`, {
          method: 'POST',
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshFloorPlan(variables.propertyId);
      },
    }),
    createTechnician: useMutation({
      mutationFn: (input: { email: string; displayName: string }) =>
        api<CreatedTechnicianAccount>('/api/v1/admin/technicians', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [keys.techniciansRoot, keys.dashboard]);
      },
    }),
    /**
     * Mail a technician a reset link.
     *
     * No cache invalidation, deliberately: this changes nothing that is
     * displayed. The token lives in a mailbox, not in the technician record,
     * so refetching the roster afterwards would only make the button look like
     * it did more than it did.
     */
    sendTechnicianPasswordReset: useMutation({
      mutationFn: (technicianId: string) =>
        api<{ email: string; delivered: boolean }>(
          `/api/v1/admin/technicians/${technicianId}/password-reset`,
          { method: 'POST' },
        ),
    }),
    /**
     * Let this technician into the console as well.
     *
     * One account, a second membership -- `UserProfile.email` is unique, so the
     * same person cannot hold two rows. Invalidates the user directory rather
     * than the technician one: nothing about them as a technician changed, but
     * they now appear on a list they were invisible to.
     */
    grantTechnicianConsoleAccess: useMutation({
      mutationFn: (technicianId: string) =>
        api<{ id: string; email: string; granted: boolean }>(
          `/api/v1/admin/technicians/${technicianId}/console-access`,
          { method: 'POST' },
        ),
      onSuccess: () => {
        void verifyAffectedQueries(client, [keys.usersRoot]);
      },
    }),
    createInspection: useMutation({
      mutationFn: (input: object) =>
        api<AdminInspection>('/api/v1/admin/inspections', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(data.id), data);
        refreshInspection(data.id);
      },
    }),
    updateInspection: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        scheduledAt?: string;
        priority?: string;
        internalNotes?: string;
        status?: string;
        cancellationReason?: string;
        nextInspectionAlert?: string;
        maintenanceComments?: string;
        generalComments?: string;
      }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshInspection(variables.id);
      },
    }),
    finalizeInspection: useMutation({
      mutationFn: ({ id, overrideReason }: { id: string; overrideReason?: string }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/finalize`, {
          method: 'POST',
          body: JSON.stringify(overrideReason ? { overrideReason } : {}),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshWorkflow(variables.id);
      },
    }),
    markInspectionTbd: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/mark-tbd`, {
          method: 'POST',
          body: JSON.stringify(reason ? { reason } : {}),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshWorkflow(variables.id);
      },
    }),
    requireInspectionFollowUp: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        dueAt?: string;
        tasks?: string;
        reason?: string;
      }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/require-follow-up`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshWorkflow(variables.id);
      },
    }),
    markInspectionUnderReview: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/under-review`, {
          method: 'POST',
          body: JSON.stringify(reason ? { reason } : {}),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshWorkflow(variables.id);
      },
    }),
    // Reason is required here, unlike the other transitions: this one can undo
    // a finalization, so the audit trail has to say why every time.
    /**
     * Permanently erase an inspection and every piece of evidence on it.
     *
     * Gated server-side on `inspections:delete`. No optimistic removal here,
     * unlike `deleteTechnician`: the caller navigates away from a page that is
     * about the deleted record, and pulling the row out from under the render
     * that is still mounted only invites a flash of "not found" on the way out.
     */
    deleteInspection: useMutation({
      mutationFn: (id: string) =>
        api<{
          deleted: boolean;
          areas: number;
          recordings: number;
          photos: number;
          findings: number;
          unlinkedInspections: number;
          orphanedStorageObjects: number;
        }>(`/api/v1/admin/inspections/${id}`, { method: 'DELETE' }),
      onSuccess: (_data, id) => {
        client.removeQueries({ queryKey: keys.inspection(id) });
        void verifyAffectedQueries(client, [
          keys.inspectionsRoot,
          keys.assignmentsRoot,
          keys.dashboard,
        ]);
      },
    }),
    /**
     * Delete several inspections in one request.
     *
     * The response reports per-id outcomes rather than a single boolean: each
     * inspection is erased in its own transaction server-side, so a batch can
     * genuinely half-succeed and the caller has to be able to say which ones.
     */
    deleteInspections: useMutation({
      mutationFn: (inspectionIds: string[]) =>
        api<{
          requested: number;
          deleted: string[];
          failed: { id: string; message: string }[];
          orphanedStorageObjects: number;
        }>('/api/v1/admin/inspections/delete', {
          method: 'POST',
          body: JSON.stringify({ inspectionIds }),
        }),
      onSuccess: (data) => {
        for (const id of data.deleted) client.removeQueries({ queryKey: keys.inspection(id) });
        void verifyAffectedQueries(client, [
          keys.inspectionsRoot,
          keys.assignmentsRoot,
          keys.dashboard,
        ]);
      },
    }),
    reopenInspection: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/reopen`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        client.setQueryData(keys.inspection(variables.id), data);
        refreshWorkflow(variables.id);
      },
    }),
    /**
     * Ask the technician for more evidence in one area.
     *
     * Refreshes the workflow as well as the request list, because the server
     * hands the inspection back to the technician in the same transaction —
     * the status on screen is stale the moment this succeeds.
     */
    createEvidenceRequest: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        inspectionAreaId: string;
        checklistItemIds?: string[];
        note: string;
      }) =>
        api<AdminEvidenceRequest>(`/api/v1/admin/inspections/${id}/evidence-requests`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => {
        refreshWorkflow(variables.id);
        void client.invalidateQueries({ queryKey: keys.evidenceRequests(variables.id) });
      },
    }),
    cancelEvidenceRequest: useMutation({
      mutationFn: ({ requestId }: { requestId: string; inspectionId: string }) =>
        api<AdminEvidenceRequest>(`/api/v1/admin/evidence-requests/${requestId}`, {
          method: 'DELETE',
        }),
      onSuccess: (_data, variables) => {
        void client.invalidateQueries({
          queryKey: keys.evidenceRequests(variables.inspectionId),
        });
      },
    }),
    /**
     * Cut a still from a recording and file it as report evidence.
     *
     * Invalidates the area bundle rather than patching it: the new photograph
     * lands in a group the client does not compute, and re-reading is cheaper
     * than reproducing that grouping here.
     */
    captureSnapshot: useMutation({
      mutationFn: ({
        mediaId,
        ...body
      }: {
        mediaId: string;
        inspectionId: string;
        areaId: string;
        atMs: number;
        checklistItemId?: string;
      }) =>
        api<{ id: string; atMs: number; reused: boolean }>(
          `/api/v1/inspection-videos/${mediaId}/snapshot`,
          {
            method: 'POST',
            body: JSON.stringify({ atMs: body.atMs, checklistItemId: body.checklistItemId }),
          },
        ),
      onSuccess: (_data, variables) => {
        void client.invalidateQueries({
          queryKey: keys.areaEvidence(variables.inspectionId, variables.areaId),
        });
      },
    }),
    /**
     * Adds approved property areas to an inspection already under way.
     *
     * `refreshWorkflow` covers the console's own views. The technician's handset
     * is told by the backend over the realtime socket rather than from here — a
     * client that has just made a change is the one client guaranteed to be
     * looking, and the person who needs to know is somewhere else entirely.
     */
    addInspectionAreas: useMutation({
      mutationFn: ({ id, propertyAreaIds }: { id: string; propertyAreaIds: string[] }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}/areas`, {
          method: 'POST',
          body: JSON.stringify({ propertyAreaIds }),
        }),
      onSuccess: (_data, variables) => {
        refreshWorkflow(variables.id);
      },
    }),
    mergeInspectionAreas: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        sourceAreaId: string;
        targetAreaId: string;
        reason?: string;
      }) =>
        api<MergeInspectionAreasResult>(`/api/v1/admin/inspections/${id}/merge-areas`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => {
        refreshWorkflow(variables.id);
        void verifyAffectedQueries(client, [
          keys.inspectionMedia(variables.id),
          keys.inspectionPhotos(variables.id),
          ['admin', 'inspection', variables.id, 'findings'],
        ]);
      },
    }),
    generateComparison: useMutation({
      mutationFn: ({ id }: { id: string }) =>
        api<AdminInspectionComparison>(`/api/v1/admin/inspections/${id}/comparison/generate`, {
          method: 'POST',
        }),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionComparison(variables.id), data);
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [keys.inspectionComparison(variables.id)]);
      },
    }),
    reviewComparison: useMutation({
      mutationFn: ({
        comparisonId,
        decision,
        note,
      }: {
        inspectionId: string;
        comparisonId: string;
        decision: 'APPROVED' | 'REJECTED';
        note?: string;
      }) =>
        api<AdminInspectionComparison>(`/api/v1/admin/comparisons/${comparisonId}/review`, {
          method: 'POST',
          body: JSON.stringify({ decision, note }),
        }),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionComparison(variables.inspectionId), data);
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [keys.inspectionComparison(variables.inspectionId)]);
      },
    }),
    overrideAreaComparison: useMutation({
      mutationFn: ({
        areaComparisonId,
        classification,
        reason,
      }: {
        inspectionId: string;
        areaComparisonId: string;
        classification: string;
        reason?: string;
      }) =>
        api<AdminInspectionComparison>(
          `/api/v1/admin/area-comparisons/${areaComparisonId}/override`,
          { method: 'POST', body: JSON.stringify({ classification, reason }) },
        ),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionComparison(variables.inspectionId), data);
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [keys.inspectionComparison(variables.inspectionId)]);
      },
    }),
    upsertChargeRule: useMutation({
      mutationFn: (input: { amount: number; code?: string; isActive?: boolean }) =>
        api<AdminChargeRule>('/api/v1/admin/charge-rules', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [keys.chargeRules]);
      },
    }),
    generatePetCandidates: useMutation({
      mutationFn: ({ id }: { id: string }) =>
        api<AdminInspectionPets>(`/api/v1/admin/inspections/${id}/pets/generate`, {
          method: 'POST',
        }),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionPets(variables.id), data);
        refreshCharges(variables.id);
      },
    }),
    reviewPetCandidate: useMutation({
      mutationFn: ({
        candidateId,
        ...input
      }: {
        inspectionId: string;
        candidateId: string;
        reviewStatus: string;
        authorizationStatus?: string;
        note?: string;
      }) =>
        api<AdminInspectionPets>(`/api/v1/admin/pet-candidates/${candidateId}/review`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionPets(variables.inspectionId), data);
        refreshCharges(variables.inspectionId);
      },
    }),
    generateCharges: useMutation({
      mutationFn: ({ id }: { id: string }) =>
        api<AdminCharge[]>(`/api/v1/admin/inspections/${id}/charges/generate`, { method: 'POST' }),
      onSuccess: (data, variables) => {
        client.setQueryData(keys.inspectionCharges(variables.id), data);
        refreshCharges(variables.id);
      },
    }),
    createCharge: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        description: string;
        unitAmount: number;
        chargeCode?: string;
        propertyAreaId?: string;
        findingId?: string;
        quantity?: number;
        reason?: string;
      }) =>
        api<AdminCharge>(`/api/v1/admin/inspections/${id}/charges`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshCharges(variables.id);
      },
    }),
    reviewCharge: useMutation({
      mutationFn: ({
        chargeId,
        ...input
      }: {
        inspectionId: string;
        chargeId: string;
        decision: 'APPROVE' | 'REJECT' | 'ADJUST' | 'WAIVE';
        approvedAmount?: number;
        reason?: string;
      }) =>
        api<AdminCharge>(`/api/v1/admin/charges/${chargeId}/review`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshCharges(variables.inspectionId);
      },
    }),
    createReportShare: useMutation({
      mutationFn: ({
        inspectionId,
        recipientEmail,
      }: {
        inspectionId: string;
        recipientEmail?: string;
      }) =>
        api<AdminReportShare>(`/api/v1/admin/inspections/${inspectionId}/report-shares`, {
          method: 'POST',
          body: JSON.stringify(recipientEmail ? { recipientEmail } : {}),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [
          keys.reportShares(variables.inspectionId),
          ['admin', 'inspection', variables.inspectionId, 'audit'],
        ]);
      },
    }),
    revokeReportShare: useMutation({
      mutationFn: ({ id }: { id: string; inspectionId: string }) =>
        api<AdminReportShare>(`/api/v1/admin/report-shares/${id}`, { method: 'DELETE' }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [
          keys.reportShares(variables.inspectionId),
          ['admin', 'inspection', variables.inspectionId, 'audit'],
        ]);
      },
    }),
    approveFinding: useMutation({
      mutationFn: ({ id, reason }: { id: string; inspectionId: string; reason?: string }) =>
        api<AdminInspectionFinding>(`/api/v1/admin/findings/${id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [
          ['admin', 'inspection', variables.inspectionId, 'findings'],
          ['admin', 'inspection', variables.inspectionId, 'audit'],
          // Counts and the derived area review status both move with a
          // decision; the prefix covers the summary and every cached area.
          keys.areaEvidenceSummary(variables.inspectionId),
        ]);
      },
    }),
    rejectFinding: useMutation({
      mutationFn: ({ id, reason }: { id: string; inspectionId: string; reason: string }) =>
        api<AdminInspectionFinding>(`/api/v1/admin/findings/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        void verifyAffectedQueries(client, [
          ['admin', 'inspection', variables.inspectionId, 'findings'],
          ['admin', 'inspection', variables.inspectionId, 'audit'],
          // Counts and the derived area review status both move with a
          // decision; the prefix covers the summary and every cached area.
          keys.areaEvidenceSummary(variables.inspectionId),
        ]);
      },
    }),
    assign: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        technicianId: string;
        reason?: string;
        idempotencyKey?: string;
      }) =>
        api<AdminAssignment>(`/api/v1/admin/inspections/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshInspection(variables.id);
      },
    }),
    reassign: useMutation({
      mutationFn: ({
        id,
        ...input
      }: {
        id: string;
        technicianId: string;
        reason?: string;
        idempotencyKey?: string;
      }) =>
        api<AdminAssignment>(`/api/v1/admin/inspections/${id}/reassign`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshInspection(variables.id);
      },
    }),
    unassign: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) =>
        api<AdminAssignment>(`/api/v1/admin/inspections/${id}/unassign`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (data, variables) => {
        mergeAuthoritativeEntity(client, keys.all, data);
        refreshInspection(variables.id);
      },
    }),
    /**
     * Deleting a technician releases their assignments, so every view that
     * shows who is covering what has to be re-read — the assignment board and
     * the dashboard queue as much as the technician list.
     */
    deleteTechnician: useMutation({
      mutationFn: (id: string) =>
        api<AccountDeletionResult>(`/api/v1/admin/technicians/${id}`, { method: 'DELETE' }),
      onMutate: async (id) => {
        await cancelAffectedQueries(client, [keys.techniciansRoot, keys.technician(id)]);
        const operationId = beginEntityOperation(id, 'DELETING');
        removeEntityFromQueries(client, keys.techniciansRoot, id);
        return { operationId };
      },
      onSuccess: (_data, id, context) => {
        if (context) completeEntityDeletion(id, context.operationId);
        void verifyAffectedQueries(client, [
          keys.techniciansRoot,
          keys.assignmentsRoot,
          keys.inspectionsRoot,
          keys.dashboard,
        ]);
      },
      onError: (_error, id, context) => {
        if (context) failEntityOperation(id, context.operationId);
        void verifyAffectedQueries(client, [keys.techniciansRoot, keys.technician(id)]);
      },
    }),
    updateTechnician: useMutation({
      mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
        api<AdminTechnician>(`/api/v1/admin/technicians/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive }),
        }),
      onMutate: async (variables) => {
        await cancelAffectedQueries(client, [keys.techniciansRoot, keys.technician(variables.id)]);
        const previous = snapshotEntity<AdminTechnician>(
          client,
          keys.techniciansRoot,
          variables.id,
        );
        const operationId = beginEntityOperation(variables.id, 'UPDATING', {
          isActive: variables.isActive,
        });
        patchEntityById(
          client,
          keys.all,
          variables.id,
          { isActive: variables.isActive },
          {
            state: 'UPDATING',
            operationId,
          },
        );
        return { operationId, previous };
      },
      onSuccess: (data, variables, context) => {
        if (!context || !completeEntityOperation(variables.id, context.operationId, data)) return;
        patchEntityInQueries(client, keys.all, data);
        void verifyAffectedQueries(client, [
          keys.techniciansRoot,
          keys.technician(variables.id),
          keys.dashboard,
        ]);
      },
      onError: (_error, variables, context) => {
        if (context) failEntityOperation(variables.id, context.operationId);
        if (context?.previous) patchEntityInQueries(client, keys.all, context.previous);
        else
          void verifyAffectedQueries(client, [keys.techniciansRoot, keys.technician(variables.id)]);
      },
    }),
    sync: useMutation({
      // Every entity, derived from the shared catalog list rather than a local
      // literal: a hardcoded ['portfolios','buildings'] here previously meant
      // units and leases never synced, while the button still promised the
      // complete catalog.
      mutationFn: (mode: 'initial' | 'incremental' | 'reconcile') =>
        api(
          `/api/v1/admin/integrations/propertyware/${mode === 'reconcile' ? 'reconcile' : `sync/${mode}`}`,
          {
            method: 'POST',
            body: JSON.stringify({ entities: allPropertywareEntities() }),
          },
        ),
      onSuccess: () => {
        void verifyAffectedQueries(client, [
          keys.propertyware,
          keys.portfoliosRoot,
          keys.syncRuns,
          keys.dashboard,
        ]);
      },
    }),
  };
}

/**
 * The API's own description, for the IT tools reference.
 *
 * Held for the session rather than refetched: the document is a few hundred
 * kilobytes and only changes when the backend is redeployed, at which point the
 * page has been reloaded anyway. `retry: false` because the two realistic
 * failures — the caller lacks `system:manage`, or the deployment cannot build
 * the document — are both answers, not blips, and retrying them three times only
 * delays saying so.
 */
export const useOpenApiDocument = () =>
  useQuery({
    queryKey: keys.openApiDocument,
    queryFn: ({ signal }) => api<ApiDocument>('/api/v1/admin/system/openapi', { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

export const useApiClients = (query: { page: number; pageSize: number; search: string }) =>
  useQuery({
    queryKey: keys.apiClients(query),
    queryFn: ({ signal }) =>
      api<{ data: ApiClientSummary[]; page: number; pageSize: number; total: number }>(
        `/api/v1/admin/api-clients?${new URLSearchParams({
          page: String(query.page),
          pageSize: String(query.pageSize),
          ...(query.search ? { search: query.search } : {}),
        }).toString()}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
  });

export interface ApiClientInput {
  name: string;
  description?: string;
  environment: 'LIVE' | 'TEST';
  permissions: string[];
  rateLimitPerMinute: number;
  requireSignature: boolean;
  allowedIps: string[];
}

/**
 * Registration and key lifecycle.
 *
 * Deliberately plain invalidation rather than the optimistic entity machinery
 * the inspection lists use. That machinery exists to keep a list someone edits
 * dozens of times a minute from flickering; a credential is issued once and
 * revoked once, and showing a key as revoked a moment before the server agrees
 * is the one place optimism is actively wrong.
 */
export function useApiClientMutations() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: keys.apiClientsRoot });
  return {
    createClient: useMutation({
      mutationFn: (input: ApiClientInput) =>
        api<ApiClientSummary>('/api/v1/admin/api-clients', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: refresh,
    }),
    updateClient: useMutation({
      mutationFn: ({
        id,
        ...input
      }: Partial<ApiClientInput> & { id: string; isActive?: boolean }) =>
        api<ApiClientSummary>(`/api/v1/admin/api-clients/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: refresh,
    }),
    revokeClient: useMutation({
      mutationFn: (id: string) =>
        api<ApiClientRevocation>(`/api/v1/admin/api-clients/${id}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
    issueKey: useMutation({
      mutationFn: ({ id, label, expiresAt }: { id: string; label?: string; expiresAt?: string }) =>
        api<IssuedApiKey>(`/api/v1/admin/api-clients/${id}/keys`, {
          method: 'POST',
          body: JSON.stringify({ label, expiresAt }),
        }),
      onSuccess: refresh,
    }),
    revokeKey: useMutation({
      mutationFn: ({ id, keyId }: { id: string; keyId: string }) =>
        api(`/api/v1/admin/api-clients/${id}/keys/${keyId}`, { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}
