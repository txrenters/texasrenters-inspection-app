import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { DemoRole, FindingStatus, InspectionStatus } from '../domain/models';
import { isDemoMode } from '../config/environment';
import { repositories } from '../repositories';

// Socket events, push notifications, app foreground, and mutations are the primary refresh paths.
// This minute-level poll is only a bounded safety net when realtime delivery is interrupted.
const assignmentRefreshInterval = process.env.NODE_ENV === 'test' ? false : 60_000;

export const queryKeys = {
  currentUser: ['currentUser'] as const,
  dashboard: ['dashboard'] as const,
  inspections: (filters: object = {}) => ['inspections', filters] as const,
  inspection: (id: string) => ['inspection', id] as const,
  rooms: (id: string) => ['inspectionRooms', id] as const,
  room: (id: string) => ['room', id] as const,
  media: (roomId: string) => ['media', roomId] as const,
  property: (id: string) => ['property', id] as const,
  floorPlan: (id: string) => ['floorPlan', id] as const,
  uploads: ['uploads'] as const,
  findings: (inspectionId?: string) => ['findings', inspectionId ?? 'all'] as const,
  finding: (id: string) => ['finding', id] as const,
};

export function useDemoUsers() {
  return useQuery({
    queryKey: ['demoUsers'],
    queryFn: () => repositories.auth.listDemoUsers(),
    enabled: isDemoMode,
  });
}
export function useCurrentUser() {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: () => repositories.auth.currentUser(),
  });
}
export function useDemoLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (role: DemoRole) => repositories.auth.signIn(role),
    onSuccess: (user) => client.setQueryData(queryKeys.currentUser, user),
  });
}
export function useApiLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      repositories.auth.signInWithPassword(email.trim(), password),
    onSuccess: (user) => client.setQueryData(queryKeys.currentUser, user),
  });
}
export function useRequiredPasswordChange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => repositories.auth.changeRequiredPassword(password),
    onSuccess: () => client.clear(),
  });
}
export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => repositories.auth.signOut(),
    onSuccess: () => client.clear(),
  });
}
export function usePasswordReset() {
  return useMutation({
    mutationFn: (email: string) => repositories.auth.resetPassword(email.trim()),
  });
}
export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => repositories.inspections.dashboard(),
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
  });
}
export function useInspections(filters: { status?: InspectionStatus; search?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.inspections(filters),
    queryFn: () => repositories.inspections.list(filters),
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}
export function useInspection(id: string) {
  return useQuery({
    queryKey: queryKeys.inspection(id),
    queryFn: () => repositories.inspections.get(id),
    enabled: Boolean(id),
  });
}
export function useInspectionContext(id: string) {
  return useQuery({
    queryKey: [...queryKeys.inspection(id), 'context'],
    queryFn: () => repositories.inspections.context(id),
    enabled: Boolean(id),
  });
}
export function useInspectionReport(id: string) {
  return useQuery({
    queryKey: [...queryKeys.inspection(id), 'report'],
    queryFn: () => repositories.inspections.report(id),
    enabled: Boolean(id),
  });
}
export function useInspectionActions(id: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.inspection(id) }),
      client.invalidateQueries({ queryKey: [...queryKeys.inspection(id), 'context'] }),
      client.invalidateQueries({ queryKey: ['inspections'] }),
      client.invalidateQueries({ queryKey: queryKeys.dashboard }),
    ]);
  return {
    start: useMutation({
      mutationFn: () => repositories.inspections.start(id),
      onSuccess: refresh,
    }),
    complete: useMutation({
      mutationFn: () => repositories.inspections.complete(id),
      onSuccess: refresh,
    }),
  };
}
export function useRooms(inspectionId: string) {
  return useQuery({
    queryKey: queryKeys.rooms(inspectionId),
    queryFn: () => repositories.inspections.rooms(inspectionId),
    enabled: Boolean(inspectionId),
  });
}
export function useRoom(roomId: string) {
  return useQuery({
    queryKey: queryKeys.room(roomId),
    queryFn: () => repositories.inspections.room(roomId),
    enabled: Boolean(roomId),
  });
}
export function useRoomMedia(roomId: string) {
  return useQuery({
    queryKey: queryKeys.media(roomId),
    queryFn: () => repositories.media.listForRoom(roomId),
    enabled: Boolean(roomId),
  });
}
export function useProperty(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.property(id),
    queryFn: () => repositories.properties.get(id),
    enabled: Boolean(id) && enabled,
  });
}
export function useFloorPlan(propertyId: string) {
  return useQuery({
    queryKey: queryKeys.floorPlan(propertyId),
    queryFn: () => repositories.floorPlans.get(propertyId),
    enabled: Boolean(propertyId),
  });
}
export function useUploads() {
  return useQuery({
    queryKey: queryKeys.uploads,
    queryFn: () => repositories.uploads.list(),
    refetchInterval: (query) => {
      const uploads = query.state.data;
      return uploads?.some(
        (item) =>
          item.status === 'COMPLETED' &&
          !['READY_FOR_REVIEW', 'FAILED'].includes(item.processingStatus),
      )
        ? 5_000
        : false;
    },
    refetchIntervalInBackground: false,
  });
}
export function useFindings(inspectionId?: string, pollWhileProcessing = false) {
  return useQuery({
    queryKey: queryKeys.findings(inspectionId),
    queryFn: () => repositories.findings.list(inspectionId),
    refetchInterval: (query) => (pollWhileProcessing && !query.state.data?.length ? 5_000 : false),
    refetchIntervalInBackground: false,
  });
}
export function useFinding(id: string, inspectionId?: string) {
  return useQuery({
    queryKey: [...queryKeys.finding(id), inspectionId ?? ''],
    queryFn: () => repositories.findings.get(id, inspectionId),
    enabled: Boolean(id),
  });
}

export function useUpdateRoom(inspectionId: string, roomId: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.room(roomId) }),
      client.invalidateQueries({ queryKey: queryKeys.rooms(inspectionId) }),
      client.invalidateQueries({
        queryKey: [...queryKeys.inspection(inspectionId), 'context'],
      }),
    ]);
  return {
    note: useMutation({
      mutationFn: (note: string) => repositories.inspections.updateRoomNote(roomId, note),
      onSuccess: refresh,
    }),
    skip: useMutation({
      mutationFn: (reason: string) => repositories.inspections.skipRoom(roomId, reason),
      onSuccess: refresh,
    }),
    complete: useMutation({
      mutationFn: () => repositories.inspections.completeRoom(roomId),
      onSuccess: refresh,
    }),
  };
}

export function useSaveRecording() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ input }: { input: Parameters<typeof repositories.media.save>[0] }) => {
      const media = await repositories.media.save(input);
      const upload = await repositories.uploads.enqueue(media);
      return { media, upload };
    },
    onSuccess: ({ media }) => {
      void client.invalidateQueries({ queryKey: queryKeys.media(media.roomId) });
      void client.invalidateQueries({ queryKey: queryKeys.room(media.roomId) });
      void client.invalidateQueries({ queryKey: queryKeys.rooms(media.inspectionId) });
      void client.invalidateQueries({ queryKey: queryKeys.uploads });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

export function useUploadActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.uploads });
  return {
    pause: useMutation({
      mutationFn: repositories.uploads.pause.bind(repositories.uploads),
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: repositories.uploads.resume.bind(repositories.uploads),
      onSuccess: refresh,
    }),
    retry: useMutation({
      mutationFn: repositories.uploads.retry.bind(repositories.uploads),
      onSuccess: refresh,
    }),
    retryProcessing: useMutation({
      mutationFn: repositories.uploads.retryProcessing.bind(repositories.uploads),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: repositories.uploads.remove.bind(repositories.uploads),
      onSuccess: refresh,
    }),
  };
}

export function useFindingActions(inspectionId: string, findingId: string) {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.finding(findingId) }),
      client.invalidateQueries({ queryKey: queryKeys.findings(inspectionId) }),
    ]);
  return {
    approve: useMutation({
      mutationFn: () => repositories.findings.approve(findingId),
      onSuccess: refresh,
    }),
    edit: useMutation({
      mutationFn: ({ observation, notes }: { observation: string; notes: string }) =>
        repositories.findings.edit(findingId, observation, notes),
      onSuccess: refresh,
    }),
    reject: useMutation({
      mutationFn: (reason: string) => repositories.findings.reject(findingId, reason),
      onSuccess: refresh,
    }),
    reinspect: useMutation({
      mutationFn: (reason: string) => repositories.findings.requestReinspection(findingId, reason),
      onSuccess: refresh,
    }),
  };
}

export function matchesInspectionFilter(status: InspectionStatus, filter: string) {
  return filter === 'ALL' || status === filter;
}
export function matchesFindingFilter(status: FindingStatus, filter: string) {
  return filter === 'ALL' || status === filter;
}
