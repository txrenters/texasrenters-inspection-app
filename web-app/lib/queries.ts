'use client';

import type {
  AdminAssignmentListItem,
  AdminAuditEvent,
  AdminDashboard,
  AdminInspection,
  AdminInspectionFinding,
  AdminInspectionMedia,
  AdminFloorPlan,
  AdminPropertyArea,
  AdminPortfolio,
  AdminProperty,
  AdminTechnician,
  CreatedTechnicianAccount,
  AdminUnit,
  AdminLease,
  PropertywareSyncRun,
  PropertywareSyncError,
  ProviderReadiness,
} from '@texasrenters/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api, type Page, queryString } from './api';

export const keys = {
  dashboard: ['admin', 'dashboard'] as const,
  portfolios: (search: string) => ['admin', 'portfolios', search] as const,
  propertyOptions: (portfolioId: string, search: string) =>
    ['admin', 'property-options', portfolioId, search] as const,
  properties: (query: object) => ['admin', 'properties', query] as const,
  property: (id: string) => ['admin', 'property', id] as const,
  floorPlans: (id: string) => ['admin', 'property', id, 'floor-plans'] as const,
  propertyAreas: (id: string) => ['admin', 'property', id, 'areas'] as const,
  units: (id: string) => ['admin', 'units', id] as const,
  leases: (id: string) => ['admin', 'leases', id] as const,
  inspections: (query: object) => ['admin', 'inspections', query] as const,
  inspection: (id: string) => ['admin', 'inspection', id] as const,
  inspectionAudit: (id: string, page: number) =>
    ['admin', 'inspection', id, 'audit', page] as const,
  inspectionMedia: (id: string) => ['admin', 'inspection', id, 'media'] as const,
  inspectionFindings: (id: string, page: number, reviewStatus: string) =>
    ['admin', 'inspection', id, 'findings', page, reviewStatus] as const,
  assignments: (query: object) => ['admin', 'assignments', query] as const,
  technicians: (query: object) => ['admin', 'technicians', query] as const,
  technician: (id: string) => ['admin', 'technician', id] as const,
  propertyware: ['admin', 'propertyware'] as const,
  syncRuns: ['admin', 'propertyware', 'runs'] as const,
  syncErrors: (runId: string, page: number) =>
    ['admin', 'propertyware', 'runs', runId, 'errors', page] as const,
  providers: ['admin', 'providers'] as const,
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
    enabled: Boolean(portfolioId),
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
export const useInspectionFindings = (id: string, page: number, reviewStatus = '') =>
  useQuery({
    queryKey: keys.inspectionFindings(id, page, reviewStatus),
    queryFn: ({ signal }) =>
      api<Page<AdminInspectionFinding>>(
        `/api/v1/admin/inspections/${id}/findings${queryString({
          page,
          pageSize: 20,
          reviewStatus: reviewStatus || undefined,
        })}`,
        { signal },
      ),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
export const useAssignments = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.assignments(query),
    queryFn: ({ signal }) =>
      api<Page<AdminAssignmentListItem>>(`/api/v1/admin/assignments${queryString(query)}`, {
        signal,
      }),
  });
export const useTechnicians = (query: Record<string, string | number | boolean | undefined>) =>
  useQuery({
    queryKey: keys.technicians(query),
    queryFn: ({ signal }) =>
      api<Page<AdminTechnician>>(`/api/v1/admin/technicians${queryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
  });
export const useTechnician = (id: string) =>
  useQuery({
    queryKey: keys.technician(id),
    queryFn: ({ signal }) => api<AdminTechnician>(`/api/v1/admin/technicians/${id}`, { signal }),
    enabled: Boolean(id),
  });
export const usePropertywareStatus = () =>
  useQuery({
    queryKey: keys.propertyware,
    queryFn: ({ signal }) =>
      api<Record<string, unknown>>('/api/v1/admin/integrations/propertyware/status', { signal }),
    refetchInterval: (query) =>
      (query.state.data as { lastRun?: { status?: string } } | undefined)?.lastRun?.status ===
      'RUNNING'
        ? 5_000
        : false,
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
      query.state.data?.items.some((run) => run.status === 'RUNNING')
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
export const useProviders = () =>
  useQuery({
    queryKey: keys.providers,
    queryFn: ({ signal }) =>
      api<{ providers: ProviderReadiness[]; checkedAt: string }>(
        '/api/v1/admin/integrations/providers/status',
        { signal },
      ),
  });

export function useAdminMutations() {
  const client = useQueryClient();
  const refreshInspection = (id?: string) => {
    void client.invalidateQueries({ queryKey: ['admin', 'inspections'] });
    void client.invalidateQueries({ queryKey: ['admin', 'assignments'] });
    void client.invalidateQueries({ queryKey: keys.dashboard });
    if (id) void client.invalidateQueries({ queryKey: keys.inspection(id) });
  };
  const refreshFloorPlan = (propertyId: string) => {
    void client.invalidateQueries({ queryKey: keys.floorPlans(propertyId) });
    void client.invalidateQueries({ queryKey: keys.propertyAreas(propertyId) });
  };
  return {
    uploadFloorPlan: useMutation({
      mutationFn: ({ propertyId, file }: { propertyId: string; file: File }) => {
        const form = new FormData();
        form.set('file', file);
        return api<AdminFloorPlan>(`/api/v1/admin/properties/${propertyId}/floor-plans`, {
          method: 'POST',
          body: form,
        });
      },
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    extractFloorPlan: useMutation({
      mutationFn: (variables: { propertyId: string; floorPlanId: string }) =>
        api(`/api/v1/admin/floor-plans/${variables.floorPlanId}/extract`, { method: 'POST' }),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
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
      }) =>
        api<AdminPropertyArea>(`/api/v1/admin/properties/${propertyId}/areas`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    createFallbackPropertyArea: useMutation({
      mutationFn: ({ propertyId }: { propertyId: string }) =>
        api<AdminPropertyArea>(`/api/v1/admin/properties/${propertyId}/areas/fallback`, {
          method: 'POST',
        }),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    updatePropertyArea: useMutation({
      mutationFn: (variables: {
        propertyId: string;
        areaId: string;
        floorName?: string;
        name?: string;
        inspectionOrder?: number;
        isRequired?: boolean;
      }) => {
        return api<AdminPropertyArea>(`/api/v1/admin/property-areas/${variables.areaId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            floorName: variables.floorName,
            name: variables.name,
            inspectionOrder: variables.inspectionOrder,
            isRequired: variables.isRequired,
          }),
        });
      },
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    deletePropertyArea: useMutation({
      mutationFn: (variables: { propertyId: string; areaId: string }) =>
        api(`/api/v1/admin/property-areas/${variables.areaId}`, { method: 'DELETE' }),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    approvePropertyAreas: useMutation({
      mutationFn: ({ propertyId, areaIds }: { propertyId: string; areaIds: string[] }) =>
        api<AdminPropertyArea[]>(`/api/v1/admin/properties/${propertyId}/areas/approve`, {
          method: 'POST',
          body: JSON.stringify({ areaIds }),
        }),
      onSuccess: (_data, variables) => refreshFloorPlan(variables.propertyId),
    }),
    createTechnician: useMutation({
      mutationFn: (input: { email: string; displayName: string }) =>
        api<CreatedTechnicianAccount>('/api/v1/admin/technicians', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: ['admin', 'technicians'] });
        void client.invalidateQueries({ queryKey: keys.dashboard });
      },
    }),
    createInspection: useMutation({
      mutationFn: (input: object) =>
        api<{ id: string }>('/api/v1/admin/inspections', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: () => refreshInspection(),
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
      }) =>
        api<AdminInspection>(`/api/v1/admin/inspections/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => refreshInspection(variables.id),
    }),
    approveFinding: useMutation({
      mutationFn: ({ id, reason }: { id: string; inspectionId: string; reason?: string }) =>
        api<AdminInspectionFinding>(`/api/v1/admin/findings/${id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (_data, variables) => {
        void client.invalidateQueries({
          queryKey: ['admin', 'inspection', variables.inspectionId, 'findings'],
        });
        void client.invalidateQueries({
          queryKey: ['admin', 'inspection', variables.inspectionId, 'audit'],
        });
      },
    }),
    rejectFinding: useMutation({
      mutationFn: ({ id, reason }: { id: string; inspectionId: string; reason: string }) =>
        api<AdminInspectionFinding>(`/api/v1/admin/findings/${id}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (_data, variables) => {
        void client.invalidateQueries({
          queryKey: ['admin', 'inspection', variables.inspectionId, 'findings'],
        });
        void client.invalidateQueries({
          queryKey: ['admin', 'inspection', variables.inspectionId, 'audit'],
        });
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
        api(`/api/v1/admin/inspections/${id}/assign`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => refreshInspection(variables.id),
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
        api(`/api/v1/admin/inspections/${id}/reassign`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      onSuccess: (_data, variables) => refreshInspection(variables.id),
    }),
    unassign: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) =>
        api(`/api/v1/admin/inspections/${id}/unassign`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        }),
      onSuccess: (_data, variables) => refreshInspection(variables.id),
    }),
    updateTechnician: useMutation({
      mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
        api(`/api/v1/admin/technicians/${id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive }),
        }),
      onSuccess: (_data, variables) => {
        void client.invalidateQueries({ queryKey: ['admin', 'technicians'] });
        void client.invalidateQueries({ queryKey: keys.technician(variables.id) });
        void client.invalidateQueries({ queryKey: keys.dashboard });
      },
    }),
    sync: useMutation({
      mutationFn: (mode: 'initial' | 'incremental' | 'reconcile') =>
        api(
          `/api/v1/admin/integrations/propertyware/${mode === 'reconcile' ? 'reconcile' : `sync/${mode}`}`,
          {
            method: 'POST',
            body: JSON.stringify({ entities: ['portfolios', 'buildings'] }),
          },
        ),
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: keys.propertyware });
        void client.invalidateQueries({ queryKey: ['admin', 'portfolios'] });
        void client.invalidateQueries({ queryKey: keys.syncRuns });
        void client.invalidateQueries({ queryKey: keys.dashboard });
      },
    }),
  };
}
