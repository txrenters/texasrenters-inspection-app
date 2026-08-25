import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type {
  Finding,
  InspectionRoom,
  LocalMedia,
  ProcessingStatus,
  RoomSnapshot,
  UploadItem,
} from '../domain/models';
import { seedFindings, seedUploads } from '../repositories/mock/data';
import { demoStorage } from '../storage/demo-storage';

interface DemoState {
  hasHydrated: boolean;
  selectedUserId: string | null;
  isOnline: boolean;
  uploadSpeed: 1 | 2 | 3;
  processingFailureEnabled: boolean;
  mockErrorEnabled: boolean;
  roomOverrides: Record<string, Partial<InspectionRoom>>;
  media: LocalMedia[];
  snapshots: RoomSnapshot[];
  uploads: UploadItem[];
  findings: Record<string, Finding>;
  /** Checklist items the technician has marked covered, keyed by area id. */
  areaChecklist: Record<string, string[]>;
  draftRecording: LocalMedia | null;
  setHasHydrated: (value: boolean) => void;
  selectUser: (id: string) => void;
  signOut: () => void;
  setOnline: (value: boolean) => void;
  setUploadSpeed: (value: 1 | 2 | 3) => void;
  setProcessingFailure: (value: boolean) => void;
  setMockError: (value: boolean) => void;
  updateRoom: (id: string, update: Partial<InspectionRoom>) => void;
  setDraftRecording: (media: LocalMedia | null) => void;
  saveMedia: (media: LocalMedia) => void;
  removeMedia: (id: string) => void;
  addSnapshot: (snapshot: RoomSnapshot) => void;
  updateSnapshot: (id: string, update: Partial<RoomSnapshot>) => void;
  removeSnapshots: (ids: readonly string[]) => void;
  toggleChecklistItem: (areaId: string, itemId: string) => void;
  /** Marks items covered without unticking anything — used by transcript matching. */
  markChecklistItemsCovered: (areaId: string, itemIds: readonly string[]) => void;
  enqueueUpload: (item: UploadItem) => void;
  updateUpload: (id: string, update: Partial<UploadItem>) => void;
  removeUpload: (id: string) => void;
  clearLocalEvidence: () => void;
  tickUploads: () => void;
  updateFinding: (id: string, update: Partial<Finding>) => void;
  resetDemoData: () => void;
}

const findingRecord = () =>
  Object.fromEntries(seedFindings.map((finding) => [finding.id, { ...finding }]));

function processingStatus(progress: number): ProcessingStatus {
  if (progress < 0.2) return 'VIDEO_PROCESSING';
  if (progress < 0.4) return 'TRANSCRIBING';
  if (progress < 0.6) return 'ANALYZING';
  if (progress < 0.78) return 'COMPARING_BASELINE';
  if (progress < 1) return 'PREPARING_FINDINGS';
  return 'READY_FOR_REVIEW';
}

const initialDemoData = () => ({
  selectedUserId: null,
  isOnline: true,
  uploadSpeed: 2 as const,
  processingFailureEnabled: false,
  mockErrorEnabled: false,
  roomOverrides: {} as Record<string, Partial<InspectionRoom>>,
  media: [] as LocalMedia[],
  snapshots: [] as RoomSnapshot[],
  uploads: seedUploads.map((item) => ({ ...item })),
  findings: findingRecord(),
  areaChecklist: {} as Record<string, string[]>,
  draftRecording: null as LocalMedia | null,
});

export const useDemoStore = create<DemoState>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      ...initialDemoData(),
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
      selectUser: (selectedUserId) => set({ selectedUserId }),
      signOut: () => set({ selectedUserId: null }),
      setOnline: (isOnline) => set({ isOnline }),
      setUploadSpeed: (uploadSpeed) => set({ uploadSpeed }),
      setProcessingFailure: (processingFailureEnabled) => set({ processingFailureEnabled }),
      setMockError: (mockErrorEnabled) => set({ mockErrorEnabled }),
      updateRoom: (id, update) =>
        set((state) => ({
          roomOverrides: {
            ...state.roomOverrides,
            [id]: { ...state.roomOverrides[id], ...update },
          },
        })),
      setDraftRecording: (draftRecording) => set({ draftRecording }),
      saveMedia: (media) =>
        set((state) => ({
          media: [media, ...state.media.filter((item) => item.id !== media.id)],
          roomOverrides: {
            ...state.roomOverrides,
            [media.roomId]: {
              ...state.roomOverrides[media.roomId],
              completionStatus: 'RECORDING_SAVED',
              uploadStatus: 'PENDING',
            },
          },
          draftRecording: null,
        })),
      removeMedia: (id) =>
        set((state) => ({ media: state.media.filter((item) => item.id !== id) })),
      toggleChecklistItem: (areaId, itemId) =>
        set((state) => {
          const current = state.areaChecklist[areaId] ?? [];
          const next = current.includes(itemId)
            ? current.filter((value) => value !== itemId)
            : [...current, itemId];
          return { areaChecklist: { ...state.areaChecklist, [areaId]: next } };
        }),
      markChecklistItemsCovered: (areaId, itemIds) =>
        set((state) => {
          const current = state.areaChecklist[areaId] ?? [];
          // Union, never a replacement: a spoken mention adds coverage but must
          // not silently untick something the technician set by hand.
          const next = [...new Set([...current, ...itemIds])];
          if (next.length === current.length) return state;
          return { areaChecklist: { ...state.areaChecklist, [areaId]: next } };
        }),
      addSnapshot: (snapshot) =>
        set((state) => ({
          snapshots: [
            snapshot,
            ...(state.snapshots ?? []).filter((item) => item.id !== snapshot.id),
          ],
        })),
      updateSnapshot: (id, update) =>
        set((state) => ({
          snapshots: (state.snapshots ?? []).map((item) =>
            item.id === id ? { ...item, ...update } : item,
          ),
        })),
      removeSnapshots: (ids) =>
        set((state) => {
          // A Set because a discarded walkthrough can carry a dozen
          // photographs, and this runs while the technician waits.
          const doomed = new Set(ids);
          return { snapshots: (state.snapshots ?? []).filter((item) => !doomed.has(item.id)) };
        }),
      enqueueUpload: (item) => set((state) => ({ uploads: [item, ...state.uploads] })),
      updateUpload: (id, update) =>
        set((state) => ({
          uploads: state.uploads.map((item) => {
            if (item.id !== id) return item;
            const operationId = item.operationId ?? `upload:${item.mediaId}`;
            const syncState =
              update.status === 'UPLOADING'
                ? 'UPLOADING'
                : update.status === 'FAILED'
                  ? 'FAILED'
                  : update.status === 'COMPLETED'
                    ? 'VERIFYING'
                    : update.status === 'PENDING' || update.status === 'PAUSED'
                      ? 'OFFLINE_PENDING'
                      : (item.__sync?.state ?? 'OFFLINE_PENDING');
            return {
              ...item,
              ...update,
              operationId,
              __sync: {
                operationId,
                state: syncState,
                ...(update.lastError ? { error: update.lastError } : {}),
              },
            };
          }),
        })),
      removeUpload: (id) =>
        set((state) => ({ uploads: state.uploads.filter((item) => item.id !== id) })),
      clearLocalEvidence: () =>
        set({
          media: [],
          snapshots: [],
          uploads: [],
          draftRecording: null,
        }),
      tickUploads: () => {
        const state = get();
        if (!state.isOnline) return;
        const roomUpdates: Record<string, Partial<InspectionRoom>> = {};
        const uploads = state.uploads.map((item) => {
          if (item.status === 'PENDING') return { ...item, status: 'UPLOADING' as const };
          if (item.status === 'UPLOADING') {
            const progress = Math.min(1, item.progress + 0.035 * state.uploadSpeed);
            if (progress >= 1) {
              roomUpdates[item.roomId] = {
                uploadStatus: 'COMPLETED',
                processingStatus: 'VIDEO_PROCESSING',
              };
              return {
                ...item,
                status: 'COMPLETED' as const,
                progress,
                processingStatus: 'VIDEO_PROCESSING' as const,
                processingProgress: 0.02,
              };
            }
            return { ...item, progress };
          }
          if (item.status === 'COMPLETED' && item.processingStatus !== 'READY_FOR_REVIEW') {
            const nextProgress = Math.min(1, item.processingProgress + 0.025 * state.uploadSpeed);
            const nextStatus =
              state.processingFailureEnabled && nextProgress > 0.52
                ? ('FAILED' as const)
                : processingStatus(nextProgress);
            roomUpdates[item.roomId] = {
              completionStatus: nextStatus === 'READY_FOR_REVIEW' ? 'COMPLETED' : 'RECORDING_SAVED',
              uploadStatus: 'COMPLETED',
              processingStatus: nextStatus,
              reviewStatus: nextStatus === 'READY_FOR_REVIEW' ? 'PENDING_REVIEW' : undefined,
            };
            return {
              ...item,
              processingProgress: nextProgress,
              processingStatus: nextStatus,
            };
          }
          return item;
        });
        set((current) => ({
          uploads,
          roomOverrides: Object.entries(roomUpdates).reduce(
            (all, [id, update]) => ({
              ...all,
              [id]: { ...all[id], ...update },
            }),
            current.roomOverrides,
          ),
        }));
      },
      updateFinding: (id, update) =>
        set((state) => {
          const current = state.findings[id];
          if (!current) return state;
          return { findings: { ...state.findings, [id]: { ...current, ...update } } };
        }),
      resetDemoData: () => set({ ...initialDemoData(), hasHydrated: true }),
    }),
    {
      name: 'texasrenters-demo-state-v2',
      storage: createJSONStorage(() => demoStorage),
      partialize: (state) => ({
        selectedUserId: state.selectedUserId,
        isOnline: state.isOnline,
        uploadSpeed: state.uploadSpeed,
        processingFailureEnabled: state.processingFailureEnabled,
        mockErrorEnabled: state.mockErrorEnabled,
        roomOverrides: state.roomOverrides,
        media: state.media,
        snapshots: state.snapshots,
        uploads: state.uploads,
        findings: state.findings,
        areaChecklist: state.areaChecklist,
        draftRecording: state.draftRecording,
      }),
      onRehydrateStorage: () => (state) => state?.setHasHydrated(true),
    },
  ),
);
