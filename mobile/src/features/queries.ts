import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReportableVisitService, VisitServicesReport } from '@texasrenters/shared';

import type {
  ChecklistAssessment,
  ChecklistItemWithAssessment,
  DemoRole,
  FindingStatus,
  Inspection,
  InspectionRoom,
  InspectionStatus,
  LocalMedia,
} from '../domain/models';
import { isDemoMode } from '../config/environment';
import { repositories } from '../repositories';
import { QueuedOfflineError } from '../repositories/api/offline-writes';
import type { ClosingComments } from '../utils/closing-comments';
import { FIELD_ACTIVE_STATUSES } from '../utils/inspection-status';
// Do not import the device store here. This module is inside the `repositories`
// import graph, and adding `useDemoStore` left the binding undefined at
// evaluation time — the app crashed on launch with
// `Property 'useDemoStore' doesn't exist`. Screens that need live device state
// import it themselves; see `useLiveUploadProgress`.
import type {
  AddAreaInput,
  FindingKind,
  InspectionListFilters,
  UpdateAreaInput,
} from '../repositories/contracts';
// Safe where the store was not: this pulls in only `auth/session` and
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

/**
 * How the job's checklist is changed: the next report, or how to reach it.
 *
 * The function form is the safe one. It is applied when the save actually runs
 * rather than when the tap happened, so an answer worked out while an earlier
 * save was still in flight builds on that one instead of overwriting it.
 */
export type ServicesReportUpdate =
  | VisitServicesReport
  | ((current: VisitServicesReport | null) => VisitServicesReport);

// Socket events, push notifications, app foreground, and mutations are the primary refresh paths.
// This minute-level poll is only a bounded safety net when realtime delivery is interrupted.
const assignmentRefreshInterval = process.env.NODE_ENV === 'test' ? false : 60_000;

/**
 * Alerts and reminders need every open assignment in one go, not a page.
 *
 * 100 is the server's maximum page size. A technician holding more than a
 * hundred *simultaneously open* inspections is not a real caseload, so this is
 * a single request in practice — unlike the 25 it replaces, which a normal
 * week's history exceeded.
 */
const ACTIVE_INSPECTION_PAGE_SIZE = 100;

export const queryKeys = {
  dayRoute: ['day-route'] as const,
  /**
   * Keep the root string in step with `NEVER_PERSISTED_QUERY_ROOTS` in
   * `src/storage/query-cache-persistence.ts`. Both of these describe where
   * somebody is *right now*; restored from disk an hour later they are not
   * stale, they are wrong, and they would steer a technician to a stop they
   * have already finished.
   */
  navigationLeg: (toStopId: string) => ['navigation-leg', toStopId] as const,
  mapSession: (mapType: string, theme: string, traffic: boolean) =>
    ['map-session', mapType, theme, traffic] as const,
  all: [] as const,
  demoUsers: ['demoUsers'] as const,
  currentUser: ['currentUser'] as const,
  technicianHome: ['technicianHome'] as const,
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
  /** Its own root: under `inspection` every refresh of the job would ask again. */
  filtersArea: (inspectionId: string) => ['filters-area', inspectionId] as const,
  /**
   * Rooted so the upload runner can refresh every area's photo list at once.
   *
   * The runner invalidated `roomRoot` — `['room']` — and stopped there, on the
   * reasonable-looking assumption that it covered an area's photographs too. It
   * does not: react-query matches a key by prefix, and `['room']` is not a
   * prefix of `['roomPhotos', id]`. Nothing else invalidated this key anywhere
   * in the app, so an uploaded photograph never reached the screen that gates
   * completion on it — the badge read "1 photo saved" off the room record while
   * the gate below it read zero off this one.
   */
  roomPhotosRoot: ['roomPhotos'] as const,
  roomPhotos: (roomId: string) => ['roomPhotos', roomId] as const,
  roomChecklist: (roomId: string) => ['roomChecklist', roomId] as const,
  evidenceRequests: (inspectionId: string) => ['evidenceRequests', inspectionId] as const,
  openEvidenceRequests: ['openEvidenceRequests'] as const,
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
    mutationFn: ({
      email,
      password,
      takeOver,
    }: {
      email: string;
      password: string;
      /** Ends the session on the technician's other device. Asked for, never assumed. */
      takeOver?: boolean;
    }) => repositories.auth.signInWithPassword(email.trim(), password, takeOver === true),
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
/**
 * The technician's own day, ordered from where they are now.
 *
 * Refetched while the app is in front, because the route is measured from a
 * live position and the remaining order changes as they drive. Not in the
 * background: re-planning a route nobody is looking at spends battery on a
 * handset that is also filming video all day.
 */
export function useDayRoute() {
  return useQuery({
    queryKey: queryKeys.dayRoute,
    queryFn: () => repositories.inspections.route(),
    refetchInterval: 2 * 60_000,
    refetchIntervalInBackground: false,
    // A failed route is not worth hammering: the technician still has the
    // stops, they are simply unordered.
    retry: 1,
  });
}

/**
 * The basemap's tile URL and the attribution that must be shown with it.
 *
 * Held for an hour because the underlying Google session token lasts a
 * fortnight and is minted on the server — this query exists to carry the
 * *bearer* token alongside it, and that is what actually goes stale. Refetching
 * on focus would re-read the keychain every time the technician comes back to
 * the screen at a red light, for a value that has not changed.
 *
 * Null is a legitimate answer, not an error: demo mode has no backend, and a
 * missing basemap degrades to the route drawn on a plain surface rather than to
 * a broken screen.
 */
export function useMapSession(options: {
  mapType: 'roadmap' | 'satellite' | 'terrain';
  theme: 'light' | 'dark';
  traffic: boolean;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.mapSession(options.mapType, options.theme, options.traffic),
    queryFn: () =>
      repositories.inspections.mapSession({
        mapType: options.mapType,
        theme: options.theme,
        traffic: options.traffic,
      }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
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
/**
 * One page of inspections at a time, filtered by the server.
 *
 * `useInfiniteQuery` rather than `useQuery` because the list is unbounded: the
 * server orders oldest-first, so a single fixed page showed the twenty-five
 * oldest records and nothing else — newly scheduled work simply never appeared.
 *
 * The filters are part of the key, so each chip keeps its own pages and
 * switching back to one does not refetch from scratch.
 */
export function useInspectionPages(filters: InspectionListFilters = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.inspections(filters),
    queryFn: ({ pageParam }) => repositories.inspections.listPage({ ...filters, page: pageParam }),
    initialPageParam: 1,
    // Driven by the server's own totalPages rather than "did I get a full
    // page", which mis-detects the end whenever the total is an exact multiple
    // of the page size.
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}

/**
 * How many inspections are assigned and not yet started, for the tab badge.
 *
 * Asks for a single row and reads the server's `total` rather than counting a
 * page. A badge is a count, so it must not be the length of whatever happened
 * to be fetched — that is the bug the list itself had, and on a badge it would
 * silently cap at the page size.
 *
 * SCHEDULED only. IN_PROGRESS is work the technician has already picked up and
 * knows about; badging it would leave a number sitting there all day with
 * nothing to act on, which is how people learn to ignore badges.
 */
export function useAssignedInspectionCount() {
  const filters = { statuses: ['SCHEDULED'] as const, pageSize: 1 };
  return useQuery({
    queryKey: queryKeys.inspections({ ...filters, view: 'badge' }),
    queryFn: () => repositories.inspections.listPage({ ...filters }),
    select: (page) => page.total,
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
    placeholderData: (previous) => previous,
  });
}

/**
 * The work the technician still owns — SCHEDULED and IN_PROGRESS.
 *
 * Alerts and reminder scheduling both want exactly this set and nothing else,
 * and both were reading the unfiltered list. That list is oldest-first and was
 * capped at twenty-five, so a technician with enough history got alerts and
 * device reminders computed over records that were mostly finished work, while
 * the newly scheduled inspections those features exist for had fallen off the
 * end. Asking the server for the statuses that matter fixes the truncation and
 * the relevance at once.
 */
export function useActiveInspections() {
  const filters = { statuses: FIELD_ACTIVE_STATUSES, pageSize: ACTIVE_INSPECTION_PAGE_SIZE };
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
    /**
     * Polls only while an area is still being analyzed.
     *
     * Submission waits on that, and waiting is only reasonable if the screen
     * releases itself. Without this the technician would sit on "Waiting for AI
     * analysis" until they thought to pull-to-refresh, which reads as a stuck
     * gate rather than a pipeline that finishes in seconds.
     *
     * Stops as soon as nothing is pending, so a report sitting open does not
     * poll the backend indefinitely.
     */
    refetchInterval: (query) =>
      query.state.data?.rooms.some((room) => room.analysisPending) ? 5_000 : false,
    refetchIntervalInBackground: false,
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
  const action = <Variables = void>(
    state: 'PROCESSING',
    request: (variables: Variables) => Promise<Awaited<ReturnType<typeof repositories.inspections.start>>>,
    /**
     * What the job looks like once the request lands, drawn before it does.
     * Held as the intent's shadow too, so a list refetch that races the
     * request cannot put the old job back on screen.
     */
    optimistic?: (variables: Variables) => Record<string, unknown>,
  ) => ({
    mutationFn: request,
    onMutate: async (variables: Variables) => {
      await cancelQueries(client, [queryKeys.inspection(id), queryKeys.inspectionsRoot]);
      const patch = optimistic?.(variables);
      const operation = beginIntent(id, state, patch);
      patchEntity(client, queryKeys.all, id, patch ?? {}, { state, operationId: operation });
      return { operation };
    },
    onSuccess: (
      inspection: Awaited<ReturnType<typeof repositories.inspections.start>>,
      _variables: Variables,
      context?: { operation: string },
    ) => {
      if (!context || !completeIntent(id, context.operation, inspection)) return;
      mergeEntity(client, queryKeys.all, inspection, context.operation);
      client.setQueryData(queryKeys.inspection(id), inspection);
      void refresh();
    },
    onError: (error: unknown, _variables: Variables, context?: { operation: string }) => {
      /*
       * Saved on the phone, to be sent when it can: what was drawn is what
       * will be, so it stays. The guard keeps it over a refetch for its usual
       * spell, and the repository reads a saved start into every copy of the
       * job after that (`withSavedStarts`). Rolling it back told a technician
       * whose start was safely kept that it "did not start".
       */
      if (optimistic && error instanceof QueuedOfflineError) {
        if (context) completeIntent(id, context.operation, undefined);
        void refresh();
        return;
      }
      if (context) failIntent(id, context.operation);
      void refresh();
    },
  });
  return {
    /**
     * Start job, shown as started the moment it is pressed (the office,
     * 2026-09-29: the confirmation was redundant and the start must be smooth).
     *
     * Takes the moment it was pressed, which is both what is drawn and what is
     * sent, so the timer never jumps when the server answers. The start is
     * saved on the phone before it is sent, and survives the app being closed
     * or the signal going (`sendSavedFirst`). Only a refusal puts the scheduled
     * job back, and the screen says so.
     */
    start: useMutation(
      action<string>(
        'PROCESSING',
        (startedAt) => repositories.inspections.start(id, startedAt),
        (startedAt) => ({ status: 'IN_PROGRESS', startedAt }),
      ),
    ),
    // The services report rides with the submission, so the note to Jobber and
    // "submitted" are written by the same request -- and so do an HVAC
    // report's closing comments.
    complete: useMutation(
      action<{ servicesReport?: VisitServicesReport; closingComments?: Partial<ClosingComments> } | undefined>(
        'PROCESSING',
        (input) => repositories.inspections.complete(id, input?.servicesReport, input?.closingComments),
      ),
    ),
    /**
     * A tick on the job's checklist.
     *
     * Takes either the report to save or, preferably, a function from the job's
     * current report to the next one — see `saveServices` below for why the
     * function form is the one that cannot lose an answer.
     *
     * Not wrapped in `action`, which puts the job into PROCESSING while it
     * runs: a technician ticking pest control is not waiting on the job's
     * state, and flashing "Processing" on the whole job for each tick would
     * read as something going wrong. The answer is written straight into the
     * cached job so the checklist redraws at once, held or sent.
     */
    saveServices: useMutation({
      /**
       * One at a time, per job.
       *
       * The checklist is stored as one document, so two answers sent at once
       * would each carry the report as it was when that tap happened and the
       * later reply would drop the earlier answer. A scope makes the second
       * wait, and it then reads the cache the first one wrote.
       */
      scope: { id: `job-services:${id}` },
      /**
       * An updater, not a report -- and that distinction is still the fix for
       * the lost answer.
       *
       * The scope only serialised the *sending*. Each caller still built its
       * payload from the job as it stood when the screen last rendered, so two
       * taps close together both started from the same report and the second
       * overwrote the first: photograph a filter, add another straight after,
       * and the photograph was gone. Answering `(current) => next` means the
       * second answer is worked out from the job as it then is.
       *
       * **The resolving and the optimistic write belong in `onMutate`, not in
       * `mutationFn`, and that correction is what makes an added filter appear
       * at once.** The note here used to claim a scoped mutation "runs both at
       * execute time". It does not. `onMutate` runs at execute time; the scope
       * gate sits *after* it, and `mutationFn` is not entered at all until the
       * mutation before it in the scope has settled (query-core `mutation.ts`
       * awaits `onMutate`, then `retryer.start()` calls `pause()` instead of
       * `run()` while `canRun()` is false).
       *
       * So with the write inside `mutationFn`, this happened, and the office
       * reported it on 2026-09-23: a technician photographs a filter -- the
       * camera fires this same scoped mutation and goes straight back -- then
       * taps Add while that PATCH is still in flight. The second mutation is
       * created and immediately paused, the optimistic write never runs, and no
       * row appears. Nothing is lost: the report is saved, so closing and
       * reopening the app showed it, which is exactly how it was described.
       *
       * `mutationFn` cannot read what `onMutate` returned -- in v5 its second
       * argument carries only `{client, meta, mutationKey}` -- so it reads the
       * cache, which is now the accumulator every queued tap has written to in
       * turn. Each request therefore still sends the report as it stands when
       * its turn comes.
       */
      onMutate: async (update: ServicesReportUpdate) => {
        await client.cancelQueries({ queryKey: queryKeys.inspection(id) });
        const current = client.getQueryData<Inspection>(queryKeys.inspection(id))?.servicesReport ?? null;
        const servicesReport = typeof update === 'function' ? update(current) : update;
        /**
         * Shown at once, before the server answers: pest control is a checkbox
         * now (the office, 2026-09-18), and a box that ticks half a second
         * after the tap reads as broken. A failure puts the server's copy back
         * (`refresh` below).
         */
        client.setQueryData(queryKeys.inspection(id), (job?: Inspection) =>
          job ? { ...job, servicesReport } : job,
        );
      },
      mutationFn: async () => {
        const servicesReport =
          client.getQueryData<Inspection>(queryKeys.inspection(id))?.servicesReport ?? null;
        // `onMutate` has already written this, so an absent report means the
        // job itself was never in the cache -- there is nothing to send and
        // sending null would erase the checklist.
        if (!servicesReport) throw new Error('That job is not loaded, so its checklist was not saved.');
        return repositories.inspections.saveServices(id, servicesReport);
      },
      onSuccess: (inspection) => {
        client.setQueryData(queryKeys.inspection(id), inspection);
        void refresh();
      },
      onError: (error: unknown) => {
        // Held on the device: the repository has already kept it and the
        // optimistic write above still stands, so the screen goes on showing
        // what was ticked rather than the answer springing back.
        if (!(error instanceof QueuedOfflineError)) void refresh();
      },
    }),
    /** The area a service's optional photographs are filed under, made on the first one. */
    serviceArea: useMutation({
      mutationFn: (service: ReportableVisitService) => repositories.inspections.serviceArea(id, service),
    }),
    /** Nobody let the technician in: the office books the whole visit again. */
    couldNotAccess: useMutation(
      action<string>('PROCESSING', (reason) => repositories.inspections.couldNotAccess(id, reason)),
    ),
  };
}
/**
 * The area a job's filter photograph is filed under, asked for before anyone
 * needs it.
 *
 * It was resolved on the first tap of Photograph, so the first photograph of
 * every job waited on a round trip before the camera opened (the office,
 * 2026-09-29). Asked for as soon as a started job with a filter change is on
 * screen instead, and kept: the server finds or creates it, so the answer never
 * changes for the job, and it is a system area nothing counts as a room.
 */
export function useFiltersArea(inspectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.filtersArea(inspectionId),
    queryFn: () => repositories.inspections.filtersArea(inspectionId),
    enabled: Boolean(inspectionId) && enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}
export function useRooms(inspectionId: string) {
  return useQuery({
    queryKey: queryKeys.rooms(inspectionId),
    queryFn: () => repositories.inspections.rooms(inspectionId),
    enabled: Boolean(inspectionId),
  });
}
/**
 * One area, drawn from the list the technician tapped it in while it loads.
 *
 * Opening an area showed a full-screen skeleton for a whole round trip -- and
 * the area screen is the most repeated tap in a job, once per area with fifteen
 * on an occupied inspection, plus again on every re-entry after the cache has
 * dropped it. The fetch is network-first (`cachedApiRecord` only falls back to
 * disk on a connection error), so a good signal still costs a blank screen and
 * a bad one costs seconds of it.
 *
 * The area is already in memory: the screen it was tapped from renders it out
 * of `roomsRoot`, parsed by the same schema through the same wrapper. So it is
 * shown at once and replaced the moment the real one lands.
 *
 * `placeholderData` rather than `initialData` deliberately: a placeholder is
 * never written into the cache and never persisted, so nothing downstream can
 * mistake the list's slightly older copy for the authority. The completion gate
 * re-evaluates as the real row arrives, and the server refuses a completion it
 * has no evidence for regardless.
 */
export function useRoom(roomId: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.room(roomId),
    queryFn: () => repositories.inspections.room(roomId),
    enabled: Boolean(roomId),
    placeholderData: () =>
      client
        .getQueriesData<InspectionRoom[]>({ queryKey: queryKeys.roomsRoot })
        .flatMap(([, rooms]) => rooms ?? [])
        .find((room) => room.id === roomId),
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

/**
 * Open requests from the office for more evidence.
 *
 * Polled on the same cadence as assignments: a request is the reason an
 * inspection came back to the technician, so it has to appear without them
 * knowing to pull-to-refresh.
 */
/**
 * Everything the office is waiting on, across assignments.
 *
 * Kept fresh by the realtime gateway rather than a tight poll — the interval is
 * the fallback for a dropped socket, not the delivery mechanism.
 */
export function useOpenEvidenceRequests() {
  return useQuery({
    queryKey: queryKeys.openEvidenceRequests,
    queryFn: () => repositories.inspections.openEvidenceRequests(),
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
  });
}

export function useEvidenceRequests(inspectionId: string) {
  return useQuery({
    queryKey: queryKeys.evidenceRequests(inspectionId),
    queryFn: () => repositories.inspections.evidenceRequests(inspectionId),
    enabled: Boolean(inspectionId),
    refetchInterval: assignmentRefreshInterval,
    refetchIntervalInBackground: false,
  });
}

export function useResolveEvidenceRequest(inspectionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => repositories.inspections.resolveEvidenceRequest(requestId),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKeys.evidenceRequests(inspectionId) }),
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

/**
 * Records how one checklist item was found.
 *
 * Optimistic, because this is a form: a toggle that waits for a round trip
 * before moving reads as broken, and the technician is often on a weak
 * connection in a unit. The queued-offline path is a *success* for the user —
 * their answer is safely on the device — so the previous value is restored only
 * when the write genuinely failed.
 */
export function useRecordChecklistItem(roomId: string) {
  const client = useQueryClient();
  const key = queryKeys.roomChecklist(roomId);
  return useMutation({
    mutationFn: ({ itemId, assessment }: { itemId: string; assessment: ChecklistAssessment }) =>
      repositories.inspections.recordChecklistItem(roomId, itemId, assessment),
    onMutate: async ({ itemId, assessment }) => {
      await cancelQueries(client, [key]);
      const previous = client.getQueryData<ChecklistItemWithAssessment[]>(key);
      client.setQueryData<ChecklistItemWithAssessment[]>(key, (current = []) =>
        current.map((item) => (item.id === itemId ? { ...item, ...assessment } : item)),
      );
      return { previous };
    },
    onSuccess: (items) => client.setQueryData(key, items),
    onError: (error, _variables, context) => {
      // A queued write is not a lost write. The repository has already written
      // the assessment into the offline cache, so rolling the screen back here
      // would contradict what is actually stored.
      if (error instanceof QueuedOfflineError) return;
      if (context?.previous) client.setQueryData(key, context.previous);
    },
  });
}

/**
 * Corrects an area this technician added.
 *
 * Not optimistic, unlike a note: the server decides whether the area is theirs
 * to change, so showing a rename that may be refused would be a lie the screen
 * has to take back.
 */
export function useUpdateArea(inspectionId: string, roomId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAreaInput) => repositories.inspections.updateArea(roomId, input),
    onSuccess: (room) => {
      mergeEntity(client, queryKeys.all, room);
      client.setQueryData(queryKeys.room(roomId), room);
      void client.invalidateQueries({ queryKey: queryKeys.rooms(inspectionId) });
    },
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
    /**
     * Removes the room from the inspection entirely.
     *
     * No `mergeEntity` and no optimistic patch: the room is gone, so there is
     * no entity to merge into and the caller navigates away. `refresh` is what
     * drops it from the area list the technician returns to.
     */
    remove: useMutation({
      mutationFn: () => repositories.inspections.removeRoom(roomId),
      onSuccess: () => {
        client.removeQueries({ queryKey: queryKeys.room(roomId) });
        void refresh();
      },
    }),
    skip: useMutation({
      mutationFn: (reason?: string) => repositories.inspections.skipRoom(roomId, reason),
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
    confirmSummary: useMutation({
      mutationFn: () => repositories.inspections.confirmRoomSummary(roomId),
      onSuccess: (room) => {
        mergeEntity(client, queryKeys.all, room);
        client.setQueryData(queryKeys.room(roomId), room);
        void refresh();
      },
    }),
  };
}

/**
 * Marks every area a technician did not walk, in one action.
 *
 * An occupied visit is offered the standard fifteen-room layout, and a real
 * property is rarely all fifteen — there is no third bedroom, no laundry, no
 * carport. Disposing of those one at a time is the per-area toll the 2026-09-09
 * feedback asked us to remove, on the visit type with the least time to pay it.
 *
 * Sequential rather than parallel, and every failure is collected rather than
 * thrown. Firing ten writes at once on a weak signal is how they all time out,
 * and one refusal in the middle must not leave the technician unable to tell
 * which areas were dealt with — this returns the tally and the screen says so.
 *
 * A queued skip counts as done. `skipRoom` holds the write when the network is
 * gone and throws `QueuedOfflineError` to say so, which is the normal case for
 * this button: the technician is standing in the property, finishing up.
 */
export function useSkipAreas(inspectionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (roomIds: readonly string[]) => {
      let skipped = 0;
      let queued = 0;
      const failed: string[] = [];
      for (const roomId of roomIds) {
        try {
          await repositories.inspections.skipRoom(roomId);
          skipped += 1;
        } catch (error) {
          if (error instanceof QueuedOfflineError) queued += 1;
          else failed.push(roomId);
        }
      }
      return { skipped, queued, failed };
    },
    onSettled: () =>
      verifyQueries(client, [
        queryKeys.roomRoot,
        queryKeys.rooms(inspectionId),
        queryKeys.inspectionContext(inspectionId),
        queryKeys.inspectionReport(inspectionId),
        queryKeys.dashboard,
      ]),
  });
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

/** The technician's own home -- where their route starts before they set off. */
export function useTechnicianHome() {
  return useQuery({
    queryKey: queryKeys.technicianHome,
    queryFn: () => repositories.home.get(),
  });
}

/**
 * Saves a home and caches what the server geocoded it to.
 *
 * The cache is written from the response rather than invalidated, so the
 * matched address the server read back appears the instant it is saved --
 * which is the moment a wrong suburb is worth catching.
 */
export function useSetTechnicianHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => repositories.home.set(address),
    onSuccess: (home) => client.setQueryData(queryKeys.technicianHome, home),
  });
}

export function useClearTechnicianHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => repositories.home.clear(),
    onSuccess: () => client.setQueryData(queryKeys.technicianHome, null),
  });
}
