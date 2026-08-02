import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { DemoRole, FindingStatus, InspectionStatus, LocalMedia } from '../domain/models';
import { isDemoMode } from '../config/environment';
import { repositories } from '../repositories';
// Do not import the device store here. This module is inside the `repositories`
// import graph, and adding `useDemoStore` left the binding undefined at
// evaluation time — the app crashed on launch with
// `Property 'useDemoStore' doesn't exist`. Screens that need live device state
// import it themselves; see `useLiveUploadProgress`.
import type { AddAreaInput, FindingKind } from '../repositories/contracts';
// Safe where the store was not: this pulls in only `auth/supabase` and
// `demo-storage`, both of which `offline-record-cache` already loads on the way
// into `repositories`, so nothing new joins the cycle.
import { clearQueryCache } from '../storage/query-cache-persistence';
import {
  beginIntent,
  cancelQueries,
  completeIntent,
  failIntent,
  mergeEntity,
  patchEntity,
  verifyQueries,
} from './state-consistency';

// Socket events, push notifications, app foreground, and mutations are the primary refresh paths.
// This minute-level poll is only a bounded safety net when realtime delivery is interrupted.
const assignmentRefreshInterval = process.env.NODE_ENV === 'test' ? false : 60_000;

export const queryKeys = {
  all: [] as const,
  demoUsers: ['demoUsers'] as const,
  currentUser: ['currentUser'] as const,
  dashboard: ['dashboard'] as const,
  inspections: (filters: object = {}) => ['inspections', filters] as const,
  inspectionsRoot: ['inspections'] as const,
  inspection: (id: string) => ['inspection', id] as const,
  inspectionContext: (id: string) => ['inspection', id, 'context'] as const,
  inspectionReport: (id: string) => ['inspection', id, 'report'] as const,
  roomsRoot: ['inspectionRooms'] as const,
  rooms: (id: string) => ['inspectionRooms', id] as const,
  roomRoot: ['room'] as const,
  room: (id: string) => ['room', id] as const,
  media: (roomId: string) => ['media', roomId] as const,
  roomPhotos: (roomId: string) => ['roomPhotos', roomId] as const,
  roomChecklist: (roomId: string) => ['roomChecklist', roomId] as const,
  property: (id: string) => ['property', id] as const,
  floorPlan: (id: string) => ['floorPlan', id] as const,
  uploads: ['uploads'] as const,
  findingsRoot: ['findings'] as const,
  // `kind` is part of the key: defects and summaries come from the same
  // endpoint, and sharing a key would let one overwrite the other's cache.
  findings: (inspectionId?: string, kind: FindingKind = 'DEFECTS') =>
    ['findings', inspectionId ?? 'all', kind] as const,
  finding: (id: string) => ['finding', id] as const,
  findingForInspection: (id: string, inspectionId?: string) =>
    ['finding', id, inspectionId ?? ''] as const,
};

export function useDemoUsers() {
  return useQuery({
    queryKey: queryKeys.demoUsers,
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
    mutationFn: async () => {
      // Before signing out, not after: the stored snapshot is keyed by user id,
      // and once the session is gone there is no key to erase it with. Leaving
      // it would hand the technician a stale assignment list on next sign-in.
      await clearQueryCache();
      await repositories.auth.signOut();
    },
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
    queryKey: queryKeys.inspectionContext(id),
    queryFn: () => repositories.inspections.context(id),
    enabled: Boolean(id),
  });
}
export function useInspectionReport(id: string) {
  return useQuery({
    queryKey: queryKeys.inspectionReport(id),
    queryFn: () => repositories.inspections.report(id),
    enabled: Boolean(id),
  });
}
export function useInspectionActions(id: string) {
  const client = useQueryClient();
  const refresh = () =>
    verifyQueries(client, [
      queryKeys.inspection(id),
      queryKeys.inspectionContext(id),
      queryKeys.inspectionsRoot,
      queryKeys.dashboard,
    ]);
  const action = (
    state: 'PROCESSING',
    request: () => Promise<Awaited<ReturnType<typeof repositories.inspections.start>>>,
  ) => ({
    mutationFn: request,
    onMutate: async () => {
      await cancelQueries(client, [queryKeys.inspection(id), queryKeys.inspectionsRoot]);
      const operation = beginIntent(id, state);
      patchEntity(client, queryKeys.all, id, {}, { state, operationId: operation });
      return { operation };
    },
    onSuccess: (
      inspection: Awaited<ReturnType<typeof repositories.inspections.start>>,
      _variables: void,
      context?: { operation: string },
    ) => {
      if (!context || !completeIntent(id, context.operation, inspection)) return;
      mergeEntity(client, queryKeys.all, inspection, context.operation);
      client.setQueryData(queryKeys.inspection(id), inspection);
      void refresh();
    },
    onError: (_error: unknown, _variables: void, context?: { operation: string }) => {
      if (context) failIntent(id, context.operation);
      void refresh();
    },
  });
  return {
    start: useMutation(action('PROCESSING', () => repositories.inspections.start(id))),
    complete: useMutation(action('PROCESSING', () => repositories.inspections.complete(id))),
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
/**
 * Photos the server holds for an area.
 *
 * Separate from the device snapshot store on purpose: that only knows about
 * captures made on this handset, so after a reinstall it would report zero
 * evidence for an area that is fully documented.
 */
export function useRoomPhotos(roomId: string) {
  return useQuery({
    queryKey: queryKeys.roomPhotos(roomId),
    queryFn: () => repositories.media.photosForRoom(roomId),
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
/**
 * The uploads list as the server and the durable queue last reported it.
 *
 * Deliberately does **not** merge in live transfer progress. This module sits
 * inside the `repositories` import graph, and importing the device store here
 * left the binding undefined at evaluation time — the whole app crashed with
 * `Property 'useDemoStore' doesn't exist`. Screens that need live progress
 * merge it themselves; see `useLiveUploadProgress`.
 */
export function useUploads() {
  return useQuery({
    queryKey: queryKeys.uploads,
    queryFn: () => repositories.uploads.list(),
    refetchInterval: (state) => {
      const uploads = state.state.data;
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
/** Defects only — the per-room narrative summary is a separate concern. */
export function useFindings(inspectionId?: string, pollWhileProcessing = false) {
  return useQuery({
    queryKey: queryKeys.findings(inspectionId, 'DEFECTS'),
    queryFn: () => repositories.findings.list(inspectionId, 'DEFECTS'),
    refetchInterval: (query) => (pollWhileProcessing && !query.state.data?.length ? 5_000 : false),
    refetchIntervalInBackground: false,
  });
}

/**
 * The AI's narrative summary for each room, keyed by room id.
 *
 * Stored server-side as a finding row, so it arrives through the same endpoint
 * with `kind=SUMMARIES`. Polls while analysis is still running so the summary
 * appears without the technician having to pull-to-refresh.
 */
export function useRoomSummaries(inspectionId?: string, pollWhileProcessing = false) {
  const query = useQuery({
    queryKey: queryKeys.findings(inspectionId, 'SUMMARIES'),
    queryFn: () => repositories.findings.list(inspectionId, 'SUMMARIES'),
    refetchInterval: (state) => (pollWhileProcessing && !state.state.data?.length ? 5_000 : false),
    refetchIntervalInBackground: false,
  });
  const byRoomId = new Map((query.data ?? []).map((finding) => [finding.roomId, finding]));
  return { ...query, byRoomId };
}
export function useFinding(id: string, inspectionId?: string) {
  return useQuery({
    queryKey: queryKeys.findingForInspection(id, inspectionId),
    queryFn: () => repositories.findings.get(id, inspectionId),
    enabled: Boolean(id),
  });
}

export function useRoomChecklist(roomId: string) {
  return useQuery({
    queryKey: queryKeys.roomChecklist(roomId),
    queryFn: () => repositories.inspections.roomChecklist(roomId),
    enabled: Boolean(roomId),
    // Checklists change when an administrator edits them, not minute to minute.
    staleTime: 5 * 60_000,
  });
}

export function useAddArea(inspectionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddAreaInput) => repositories.inspections.addArea(inspectionId, input),
    onSuccess: (room) => {
      mergeEntity(client, queryKeys.all, room);
      client.setQueryData<Awaited<ReturnType<typeof repositories.inspections.rooms>>>(
        queryKeys.rooms(inspectionId),
        (current = []) =>
          current.some((item) => item.id === room.id) ? current : [...current, room],
      );
      void verifyQueries(client, [
        queryKeys.rooms(inspectionId),
        queryKeys.inspectionContext(inspectionId),
      ]);
    },
  });
}

export function useUpdateRoom(inspectionId: string, roomId: string) {
  const client = useQueryClient();
  const refresh = () =>
    verifyQueries(client, [
      queryKeys.room(roomId),
      queryKeys.rooms(inspectionId),
      queryKeys.inspectionContext(inspectionId),
    ]);
  return {
    note: useMutation({
      mutationFn: (note: string) => repositories.inspections.updateRoomNote(roomId, note),
      onMutate: async (note) => {
        await cancelQueries(client, [queryKeys.room(roomId), queryKeys.rooms(inspectionId)]);
        const previous = client.getQueryData(queryKeys.room(roomId));
        const operation = beginIntent(roomId, 'UPDATING', { note });
        patchEntity(
          client,
          queryKeys.all,
          roomId,
          { note },
          {
            state: 'UPDATING',
            operationId: operation,
          },
        );
        return { operation, previous };
      },
      onSuccess: (room, _note, context) => {
        if (!context || !completeIntent(roomId, context.operation, room)) return;
        mergeEntity(client, queryKeys.all, room, context.operation);
        client.setQueryData(queryKeys.room(roomId), room);
        void refresh();
      },
      onError: (_error, _note, context) => {
        if (!context) return;
        failIntent(roomId, context.operation);
        if (context.previous) client.setQueryData(queryKeys.room(roomId), context.previous);
        void refresh();
      },
    }),
    skip: useMutation({
      mutationFn: (reason: string) => repositories.inspections.skipRoom(roomId, reason),
      onSuccess: (room) => {
        mergeEntity(client, queryKeys.all, room);
        client.setQueryData(queryKeys.room(roomId), room);
        void refresh();
      },
    }),
    complete: useMutation({
      mutationFn: () => repositories.inspections.completeRoom(roomId),
      onSuccess: (room) => {
        mergeEntity(client, queryKeys.all, room);
        client.setQueryData(queryKeys.room(roomId), room);
        void refresh();
      },
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
    onSuccess: ({ media, upload }) => {
      client.setQueryData<LocalMedia[]>(queryKeys.media(media.roomId), (current = []) =>
        current.some((item) => item.id === media.id) ? current : [media, ...current],
      );
      client.setQueryData<Awaited<ReturnType<typeof repositories.uploads.list>>>(
        queryKeys.uploads,
        (current = []) =>
          current.some((item) => item.id === upload.id) ? current : [upload, ...current],
      );
      void verifyQueries(client, [
        queryKeys.room(media.roomId),
        queryKeys.rooms(media.inspectionId),
        queryKeys.dashboard,
      ]);
    },
  });
}

export function useUploadActions() {
  const client = useQueryClient();
  const run = (action: (id: string) => Promise<void>) => async (id: string) => {
    await action(id);
    return repositories.uploads.list();
  };
  const refresh = (uploads: Awaited<ReturnType<typeof repositories.uploads.list>>) =>
    client.setQueryData(queryKeys.uploads, uploads);
  return {
    pause: useMutation({
      mutationFn: run(repositories.uploads.pause.bind(repositories.uploads)),
      onSuccess: refresh,
    }),
    resume: useMutation({
      mutationFn: run(repositories.uploads.resume.bind(repositories.uploads)),
      onSuccess: refresh,
    }),
    retry: useMutation({
      mutationFn: run(repositories.uploads.retry.bind(repositories.uploads)),
      onSuccess: refresh,
    }),
    retryProcessing: useMutation({
      mutationFn: run(repositories.uploads.retryProcessing.bind(repositories.uploads)),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: run(repositories.uploads.remove.bind(repositories.uploads)),
      onSuccess: refresh,
    }),
  };
}

export function useFindingActions(inspectionId: string, findingId: string) {
  const client = useQueryClient();
  const refresh = () =>
    verifyQueries(client, [queryKeys.finding(findingId), queryKeys.findings(inspectionId)]);
  const authoritative = (finding: Awaited<ReturnType<typeof repositories.findings.approve>>) => {
    mergeEntity(client, queryKeys.all, finding);
    void refresh();
  };
  return {
    approve: useMutation({
      mutationFn: () => repositories.findings.approve(findingId),
      onSuccess: authoritative,
    }),
    edit: useMutation({
      mutationFn: ({ observation, notes }: { observation: string; notes: string }) =>
        repositories.findings.edit(findingId, observation, notes),
      onSuccess: authoritative,
    }),
    reject: useMutation({
      mutationFn: (reason: string) => repositories.findings.reject(findingId, reason),
      onSuccess: authoritative,
    }),
    reinspect: useMutation({
      mutationFn: (reason: string) => repositories.findings.requestReinspection(findingId, reason),
      onSuccess: authoritative,
    }),
  };
}

export function matchesInspectionFilter(status: InspectionStatus, filter: string) {
  return filter === 'ALL' || status === filter;
}
export function matchesFindingFilter(status: FindingStatus, filter: string) {
  return filter === 'ALL' || status === filter;
}
