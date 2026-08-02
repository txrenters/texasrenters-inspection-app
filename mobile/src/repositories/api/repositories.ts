import * as LegacyFileSystem from 'expo-file-system/legacy';

import { getSupabaseClient } from '../../auth/supabase';
import { environment } from '../../config/environment';
import { pushDeviceStorage } from '../../realtime/push-device-storage';
import type { LocalMedia, PhotoCaptureType, UploadItem } from '../../domain/models';
import { useDemoStore } from '../../stores/demo.store';
import {
  ApiConnectionError,
  cachedApiRecord,
  SessionExpiredError,
  storeApiRecord,
  updateApiRecord,
  updateExistingApiRecord,
} from '../../storage/offline-record-cache';
import type {
  AddAreaInput,
  AuthRepository,
  CatalogRepository,
  FindingKind,
  FindingRepository,
  FloorPlanRepository,
  InspectionRepository,
  MediaRepository,
  PropertyRepository,
  UploadRepository,
} from '../contracts';
import { resolveApiUrl } from '@texasrenters/shared';
import { z } from 'zod';

const propertySchema = z.object({
  id: z.string(),
  externalPropertyId: z.string(),
  externalOwnerId: z.string(),
  externalPortfolioId: z.string(),
  name: z.string(),
  address: z.string(),
  unitName: z.string().nullable().optional(),
  cityStateZip: z.string(),
  bedrooms: z.number(),
  bathrooms: z.number(),
  floors: z.array(z.string()),
  accessInstructions: z.string(),
  notes: z.string(),
  imageTone: z.enum(['teal', 'navy', 'sand', 'sage']),
});
const inspectionSchema = z.object({
  id: z.string(),
  externalInspectionId: z.string(),
  propertyId: z.string(),
  unitId: z.string().nullable().optional(),
  unitName: z.string().nullable().optional(),
  type: z.enum(['MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT', 'HVAC']),
  baselineInspectionId: z.string().nullable().optional(),
  baselineScheduledAt: z.string().optional(),
  scheduledAt: z.string(),
  assignedUserId: z.string(),
  status: z.enum([
    'SCHEDULED',
    'IN_PROGRESS',
    'PROCESSING',
    'REVIEW_REQUIRED',
    'COMPLETED',
    'CANCELLED',
  ]),
  priority: z.enum(['STANDARD', 'HIGH']),
  roomIds: z.array(z.string()),
  propertyNotes: z.string(),
  property: propertySchema.pick({ id: true, address: true, cityStateZip: true, imageTone: true }),
  progress: z.object({
    completed: z.number(),
    total: z.number(),
    hasFailedUpload: z.boolean(),
  }),
  updatedAt: z.string().optional(),
});
const roomSchema = z.object({
  id: z.string(),
  inspectionId: z.string(),
  propertyAreaId: z.string(),
  name: z.string(),
  floorName: z.string(),
  order: z.number(),
  isRequired: z.boolean(),
  inspectionType: z.enum(['MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT', 'HVAC']),
  baseline: z.object({
    summary: z.string(),
    condition: z.enum(['DOCUMENTED', 'LIMITED', 'NOT_AVAILABLE']),
    existingDefects: z.array(z.string()),
    evidenceCount: z.number(),
  }),
  completionStatus: z.enum(['NOT_STARTED', 'RECORDING_SAVED', 'COMPLETED', 'SKIPPED']),
  uploadStatus: z.enum(['PENDING', 'UPLOADING', 'PAUSED', 'FAILED', 'COMPLETED']),
  processingStatus: z.enum([
    'NOT_STARTED',
    'VIDEO_PROCESSING',
    'TRANSCRIBING',
    'ANALYZING',
    'COMPARING_BASELINE',
    'PREPARING_FINDINGS',
    'READY_FOR_REVIEW',
    'FAILED',
  ]),
  note: z.string().optional(),
  skipReason: z.string().optional(),
  // Defaults keep older cached rooms (pre-Phase-2) parseable.
  environment: z.enum(['INDOOR', 'OUTDOOR', 'SEMI_OUTDOOR']).default('INDOOR'),
  category: z.string().nullable().optional(),
  source: z.string().default('AI_FLOOR_PLAN'),
  areaStatus: z.enum(['DRAFT', 'APPROVED', 'REJECTED']).default('APPROVED'),
  updatedAt: z.string().optional(),
});
// Exported for the offline round-trip tests: these schemas are re-parsed
// against their own cached output, so their shape has to be verifiable.
export const findingSchema = z.object({
  id: z.string(),
  inspectionId: z.string(),
  roomId: z.string(),
  roomName: z.string(),
  title: z.string(),
  category: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  comparisonResult: z.enum([
    'POSSIBLE_NEW_DAMAGE',
    'EXISTING_CONDITION',
    'NO_MATERIAL_CHANGE',
    'NORMAL_WEAR',
    'OWNER_MAINTENANCE',
    'MISSING_EVIDENCE',
    'INSUFFICIENT_DATA',
  ]),
  confidence: z.number(),
  videoTimestampStart: z.number(),
  videoTimestampEnd: z.number(),
  baselineCondition: z.string(),
  observation: z.string(),
  aiSummary: z.string(),
  recommendedReview: z.string(),
  reviewStatus: z.enum([
    'PENDING_REVIEW',
    'APPROVED',
    'EDITED',
    'REJECTED',
    'REINSPECTION_REQUESTED',
  ]),
  reviewerNotes: z.string().optional(),
  updatedAt: z.string().optional(),
});
export const roomPhotoSchema = z
  .object({
    id: z.string(),
    roomId: z.string(),
    findingId: z.string().nullish(),
    // Permissive: the server's PhotoCaptureType enum has grown over time, and a
    // photo with an unrecognised type must still be counted as evidence rather
    // than failing the whole request.
    captureType: z.string(),
    sequenceNumber: z.number().nullish(),
    label: z.string().nullish(),
    capturedAt: z.string(),
    contentPath: z.string(),
  })
  // Normalising inside the schema, not at the call site, so what gets written
  // to the offline cache is already the final shape and survives a round trip
  // back through this same parser.
  .transform((photo) => ({
    ...photo,
    findingId: photo.findingId ?? null,
    captureType: photo.captureType as PhotoCaptureType,
    sequenceNumber: photo.sequenceNumber ?? null,
    label: photo.label ?? null,
  }));
const checklistSchema = z.array(
  z.object({ id: z.string(), label: z.string(), keywords: z.array(z.string()).default([]) }),
);

const uploadSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  inspectionId: z.string(),
  roomId: z.string(),
  propertyAddress: z.string(),
  roomName: z.string(),
  durationSeconds: z.number(),
  estimatedSizeMb: z.number(),
  status: z.enum(['PENDING', 'UPLOADING', 'PAUSED', 'FAILED', 'COMPLETED']),
  progress: z.number(),
  processingStatus: roomSchema.shape.processingStatus,
  processingProgress: z.number(),
  createdAt: z.string(),
});
const floorPlanSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    sizeBytes: z.number().int().nonnegative(),
    status: z.literal('APPROVED'),
    createdAt: z.string(),
    contentPath: z.string().startsWith('/api/v1/technician/floor-plans/'),
  })
  .nullable();
const profileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  mustChangePassword: z.boolean(),
});
const inspectionContextSchema = z.object({
  inspection: inspectionSchema,
  property: propertySchema,
  rooms: z.array(roomSchema),
  pendingReviewCount: z.number(),
});
const reportSchema = z.object({
  inspection: inspectionSchema,
  property: propertySchema,
  generatedAt: z.string(),
  rooms: z.array(
    roomSchema.extend({
      // Defaulted so a client running against an older backend still parses.
      photoCount: z.number().default(0),
      summary: z.string().nullable(),
      findings: z.array(
        z.object({
          id: z.string(),
          findingType: z.enum([
            'POSSIBLE_NEW_DAMAGE',
            'EXISTING_CONDITION',
            'MAINTENANCE',
            'NO_CHANGE',
          ]),
          title: z.string(),
          category: z.string(),
          severity: findingSchema.shape.severity,
          comparisonResult: z.string(),
          confidence: z.number(),
          description: z.string(),
          recommendedReview: z.string(),
          reviewStatus: findingSchema.shape.reviewStatus,
        }),
      ),
    }),
  ),
  totals: z.object({
    rooms: z.number(),
    finishedRooms: z.number(),
    summaries: z.number(),
    defectFindings: z.number(),
    photos: z.number().default(0),
    pendingReviewCount: z.number(),
  }),
});
const dashboardSchema = z.object({
  today: z.number(),
  inProgress: z.number(),
  completed: z.number(),
  pendingUploads: z.number(),
  assignments: z.array(inspectionSchema),
  recent: z.array(inspectionSchema),
});

export async function requestJson(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!environment.apiBaseUrl)
    throw new Error('The TexasRenters API URL is not configured for this app build.');
  const { data } = await getSupabaseClient().auth.getSession();
  if (!data.session) throw new SessionExpiredError();
  const method = (options.method ?? 'GET').toUpperCase();
  const canFallback = method === 'GET' || method === 'HEAD';
  const baseUrls = environment.apiBaseUrls.length
    ? environment.apiBaseUrls
    : [environment.apiBaseUrl];

  for (const [index, baseUrl] of baseUrls.entries()) {
    const hasFallback = canFallback && index < baseUrls.length - 1;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(resolveApiUrl(baseUrl, path), {
        ...options,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${data.session.access_token}`,
          ...options.headers,
        },
      });
    } catch {
      if (hasFallback && !options.signal?.aborted) continue;
      if (controller.signal.aborted && !options.signal?.aborted)
        throw new ApiConnectionError(
          'The TexasRenters API did not respond in time. Check the server and retry.',
        );
      throw new ApiConnectionError(
        'Cannot connect to the TexasRenters API. Check the server and retry.',
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (hasFallback && [502, 503, 504].includes(response.status)) continue;
      const message = payload?.message ?? `TexasRenters API request failed (${response.status}).`;
      // A token that expired server-side is the common case; the local
      // getSession() check above only catches a session missing outright.
      // 403 is deliberately excluded: that is a permissions problem, and
      // signing out would hide it behind a misleading login prompt.
      if (response.status === 401) throw new SessionExpiredError();
      if (response.status >= 500) throw new ApiConnectionError(message);
      throw new Error(message);
    }
    return response.status === 204 ? undefined : response.json();
  }
  throw new ApiConnectionError(
    'Cannot connect to the TexasRenters API. Check the server and retry.',
  );
}

const getJson = (path: string) => requestJson(path);
const writeJson = (path: string, method: 'POST' | 'PATCH', body?: object) =>
  requestJson(path, { method, body: body ? JSON.stringify(body) : undefined });
const unavailable = (message: string): never => {
  throw new Error(message);
};

export class ApiAuthRepository implements AuthRepository {
  listDemoUsers = async () => unavailable('Demo accounts are disabled in this app build.');
  signIn = async () => unavailable('Demo sign-in is disabled in this app build.');
  async signInWithPassword(email: string, password: string) {
    const { data, error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? 'Sign-in failed.');
    const user = await this.currentUser();
    if (!user) throw new Error('No active TexasRenters profile or organization membership.');
    return user;
  }
  async changeRequiredPassword(password: string) {
    await writeJson('/api/v1/auth/change-required-password', 'POST', { password });
    await getSupabaseClient().auth.signOut({ scope: 'local' });
  }
  async resetPassword(email: string) {
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email);
    if (error) throw new Error(error.message);
  }
  async currentUser() {
    const { data } = await getSupabaseClient().auth.getSession();
    if (!data.session) return null;
    const profile = await cachedApiRecord('auth:profile', profileSchema, () =>
      getJson('/api/v1/auth/me'),
    );
    if (!profile.roles.includes('INSPECTION_TECHNICIAN')) {
      await getSupabaseClient().auth.signOut({ scope: 'local' });
      throw new Error('TexasRenters Inspection Mobile is available only to technicians.');
    }
    useDemoStore.getState().selectUser(profile.id);
    return {
      id: profile.id,
      name: profile.displayName,
      initials: profile.displayName
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase())
        .join(''),
      role: 'TECHNICIAN',
      roleLabel: 'Inspection technician',
      mustChangePassword: profile.mustChangePassword,
    } as const;
  }
  async signOut() {
    const pushToken = await pushDeviceStorage.get();
    if (pushToken) {
      try {
        await requestJson('/api/v1/technician/notification-devices', {
          method: 'DELETE',
          body: JSON.stringify({ expoPushToken: pushToken }),
        });
      } catch {
        // Local sign-out must still complete if the backend is temporarily unreachable.
      } finally {
        await pushDeviceStorage.clear();
      }
    }
    const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' });
    useDemoStore.getState().signOut();
    if (error) throw new Error(error.message);
  }
}

export class ApiPropertyRepository implements PropertyRepository {
  async list() {
    const inspections = z
      .object({ items: z.array(inspectionSchema) })
      .parse(await getJson('/api/v1/technician/inspections?page=1&pageSize=100')).items;
    const ids = [
      ...new Set(inspections.map((inspection) => inspection.propertyId).filter(Boolean)),
    ];
    return Promise.all(ids.map((id) => this.get(id)));
  }
  async get(id: string) {
    return cachedApiRecord(`property:${id}`, propertySchema, () =>
      getJson(`/api/v1/technician/properties/${encodeURIComponent(id)}`),
    );
  }
}

export class ApiCatalogRepository implements CatalogRepository {
  portfolios = async () => [];
  properties = async () => new ApiPropertyRepository().list();
  units = async () => [];
  leases = async () => [];
}

export class ApiInspectionRepository implements InspectionRepository {
  async dashboard() {
    return cachedApiRecord('dashboard', dashboardSchema, () =>
      getJson('/api/v1/technician/dashboard'),
    );
  }
  async list(filters: { status?: string; search?: string } = {}) {
    const query = new URLSearchParams({ page: '1', pageSize: '25' });
    if (filters.status) query.set('status', filters.status);
    if (filters.search?.trim()) query.set('search', filters.search.trim());
    const schema = z.object({ items: z.array(inspectionSchema) });
    return (
      await cachedApiRecord(`inspections:${query.toString()}`, schema, () =>
        getJson(`/api/v1/technician/inspections?${query.toString()}`),
      )
    ).items;
  }
  async get(id: string) {
    return cachedApiRecord(`inspection:${id}`, inspectionSchema, () =>
      getJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}`),
    );
  }
  async context(id: string) {
    const context = await cachedApiRecord(`inspection-context:${id}`, inspectionContextSchema, () =>
      getJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/context`),
    );
    await Promise.all([
      storeApiRecord(`inspection:${id}`, inspectionSchema, context.inspection),
      storeApiRecord(`property:${context.property.id}`, propertySchema, context.property),
      storeApiRecord(`inspection-rooms:${id}`, z.array(roomSchema), context.rooms),
      ...context.rooms.map((room) => storeApiRecord(`room:${room.id}`, roomSchema, room)),
    ]);
    return { ...context, rooms: context.rooms.map(withLocalRoomState) };
  }
  async report(id: string) {
    return cachedApiRecord(`inspection-report:${id}`, reportSchema, () =>
      getJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/report`),
    );
  }
  async start(id: string) {
    const inspection = inspectionSchema.parse(
      await writeJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/start`, 'POST'),
    );
    await Promise.all([
      storeApiRecord(`inspection:${id}`, inspectionSchema, inspection),
      updateExistingApiRecord(`inspection-context:${id}`, inspectionContextSchema, (current) => ({
        ...current,
        inspection,
      })),
    ]);
    return inspection;
  }
  async complete(id: string) {
    const inspection = inspectionSchema.parse(
      await writeJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/complete`, 'POST'),
    );
    await Promise.all([
      storeApiRecord(`inspection:${id}`, inspectionSchema, inspection),
      updateExistingApiRecord(`inspection-context:${id}`, inspectionContextSchema, (current) => ({
        ...current,
        inspection,
      })),
    ]);
    return inspection;
  }
  async rooms(inspectionId: string) {
    const rooms = await cachedApiRecord(
      `inspection-rooms:${inspectionId}`,
      z.array(roomSchema),
      () => getJson(`/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/rooms`),
    );
    return rooms.map(withLocalRoomState);
  }
  async room(roomId: string) {
    return withLocalRoomState(
      await cachedApiRecord(`room:${roomId}`, roomSchema, () =>
        getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}`),
      ),
    );
  }
  async roomChecklist(roomId: string) {
    return cachedApiRecord(`roomChecklist:${roomId}`, checklistSchema, () =>
      getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/checklist`),
    );
  }
  async addArea(inspectionId: string, input: AddAreaInput) {
    const room = withLocalRoomState(
      roomSchema.parse(
        await writeJson(
          `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/areas`,
          'POST',
          input,
        ),
      ),
    );
    await Promise.all([
      storeApiRecord(`room:${room.id}`, roomSchema, room),
      updateApiRecord(`inspection-rooms:${inspectionId}`, z.array(roomSchema), (current = []) =>
        current.some((item) => item.id === room.id) ? current : [...current, room],
      ),
      updateExistingApiRecord(
        `inspection-context:${inspectionId}`,
        inspectionContextSchema,
        (current) => ({
          ...current,
          rooms: current.rooms.some((item) => item.id === room.id)
            ? current.rooms
            : [...current.rooms, room],
        }),
      ),
    ]);
    return room;
  }
  async updateRoomNote(roomId: string, note: string) {
    const room = roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/note`, 'PATCH', {
        note,
      }),
    );
    await this.persistRoom(room);
    return room;
  }
  async skipRoom(roomId: string, reason: string) {
    const room = roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/skip`, 'POST', {
        reason,
      }),
    );
    await this.persistRoom(room);
    return room;
  }
  async completeRoom(roomId: string) {
    const room = roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/complete`, 'POST'),
    );
    await this.persistRoom(room);
    return room;
  }

  private async persistRoom(room: z.output<typeof roomSchema>) {
    await Promise.all([
      storeApiRecord(`room:${room.id}`, roomSchema, room),
      updateApiRecord(
        `inspection-rooms:${room.inspectionId}`,
        z.array(roomSchema),
        (current = []) => {
          const next = current.map((item) => (item.id === room.id ? room : item));
          return next.some((item) => item.id === room.id) ? next : [...next, room];
        },
      ),
      updateExistingApiRecord(
        `inspection-context:${room.inspectionId}`,
        inspectionContextSchema,
        (current) => ({
          ...current,
          rooms: current.rooms.map((item) => (item.id === room.id ? room : item)),
        }),
      ),
    ]);
  }
}

export class ApiFloorPlanRepository implements FloorPlanRepository {
  async get(propertyId: string) {
    const plan = floorPlanSchema.parse(
      await getJson(`/api/v1/technician/properties/${encodeURIComponent(propertyId)}/floor-plan`),
    );
    if (!plan) return null;
    const { data } = await getSupabaseClient().auth.getSession();
    if (!data.session) throw new SessionExpiredError();
    return {
      ...plan,
      contentSources: environment.apiBaseUrls.map((baseUrl) => ({
        uri: resolveApiUrl(baseUrl, plan.contentPath),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      })),
    };
  }
  rooms = async (_propertyId: string, inspectionId: string) =>
    new ApiInspectionRepository().rooms(inspectionId);
}

export class ApiMediaRepository implements MediaRepository {
  async listForRoom(roomId: string) {
    const localRecords = useDemoStore
      .getState()
      .media.filter(
        (item) =>
          item.ownerUserId === useDemoStore.getState().selectedUserId &&
          item.roomId === roomId &&
          item.id.startsWith('local-media-'),
      );
    let records: {
      id: string;
      inspectionId: string;
      inspectionAreaId: string;
      durationSeconds: number;
      recordingType?: 'PRIMARY_AREA' | 'ADDITIONAL_ISSUE';
      label?: string | null;
      category?: string | null;
      createdAt: string;
    }[];
    try {
      records = z
        .array(
          z.object({
            id: z.string(),
            inspectionId: z.string(),
            inspectionAreaId: z.string(),
            durationSeconds: z.number(),
            recordingType: z.enum(['PRIMARY_AREA', 'ADDITIONAL_ISSUE']).optional(),
            label: z.string().nullish(),
            category: z.string().nullish(),
            createdAt: z.string(),
          }),
        )
        .parse(await getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/media`));
    } catch (error) {
      if (localRecords.length) return localRecords;
      throw error;
    }
    const remoteRecords = records.map((record) => ({
      id: record.id,
      inspectionId: record.inspectionId,
      roomId: record.inspectionAreaId,
      recordingType: record.recordingType ?? 'PRIMARY_AREA',
      label: record.label ?? undefined,
      category: (record.category ?? undefined) as LocalMedia['category'],
      uri: '',
      durationSeconds: record.durationSeconds,
      estimatedSizeMb: 0,
      recordedAt: record.createdAt,
      note: '',
    }));
    // Keep the durable local file after server confirmation, but show the
    // authoritative server record once it exists so the room never displays a
    // duplicate recording.
    return remoteRecords.length ? remoteRecords : localRecords;
  }
  async save(input: Omit<LocalMedia, 'id' | 'recordedAt'>) {
    const media: LocalMedia = {
      ...input,
      id: `local-media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ownerUserId: useDemoStore.getState().selectedUserId ?? undefined,
      recordedAt: new Date().toISOString(),
    };
    useDemoStore.getState().saveMedia(media);
    return media;
  }
  async photosForRoom(roomId: string) {
    // Cached so a technician re-opening an area without signal still sees how
    // much evidence exists there. Without it the completion checklist reports
    // zero photos offline, which reads as "you have not documented this".
    return cachedApiRecord(`room-photos:${roomId}`, z.array(roomPhotoSchema), () =>
      getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/photos`),
    );
  }
}

let uploadInFlight = false;

export class ApiUploadRepository implements UploadRepository {
  async list() {
    const localRecords = localUploads();
    try {
      const remoteRecords = z
        .array(uploadSchema)
        .parse(await getJson('/api/v1/technician/uploads'));
      return [
        ...localRecords,
        ...remoteRecords.filter(
          (remote) => !localRecords.some((local) => local.mediaId === remote.mediaId),
        ),
      ];
    } catch (error) {
      if (localRecords.length) return localRecords;
      throw error;
    }
  }
  async enqueue(media: LocalMedia) {
    if (!media.ownerUserId || media.ownerUserId !== useDemoStore.getState().selectedUserId)
      throw new Error('This recording belongs to a different technician session.');
    const existing = localUploads().find((item) => item.mediaId === media.id);
    if (existing) return existing;
    const item: UploadItem = {
      id: `local-upload-${media.id}`,
      ownerUserId: media.ownerUserId,
      mediaId: media.id,
      inspectionId: media.inspectionId,
      roomId: media.roomId,
      recordingType: media.recordingType ?? 'PRIMARY_AREA',
      label: media.label,
      category: media.category,
      relatedFindingId: media.relatedFindingId,
      propertyAddress: media.propertyAddress ?? 'Assigned property',
      roomName: media.roomName ?? 'Room evidence',
      durationSeconds: media.durationSeconds,
      estimatedSizeMb: media.estimatedSizeMb,
      status: 'PENDING',
      progress: 0,
      processingStatus: 'NOT_STARTED',
      processingProgress: 0,
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      operationId: `upload:${media.id}`,
      __sync: { state: 'OFFLINE_PENDING', operationId: `upload:${media.id}` },
    };
    useDemoStore.getState().enqueueUpload(item);
    void this.tick();
    return item;
  }
  async pause(id: string) {
    this.updateLocal(id, { status: 'PAUSED' });
  }
  async resume(id: string) {
    this.updateLocal(id, {
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
    });
    void this.tick();
  }
  async retry(id: string) {
    this.updateLocal(id, {
      status: 'PENDING',
      progress: 0,
      attemptCount: 0,
      nextAttemptAt: undefined,
      lastError: undefined,
    });
    void this.tick();
  }
  async retryProcessing(id: string) {
    if (localUploads().some((item) => item.id === id)) {
      this.updateLocal(id, { processingStatus: 'NOT_STARTED', processingProgress: 0 });
      return;
    }
    // Server-backed uploads: id is the media id — ask the backend to re-run
    // transcription and AI analysis.
    await writeJson(`/api/v1/technician/media/${encodeURIComponent(id)}/reprocess`, 'POST');
  }
  async remove(id: string) {
    if (!localUploads().some((item) => item.id === id))
      return unavailable('Server-backed uploads cannot be removed from the device.');
    useDemoStore.getState().removeUpload(id);
  }

  // Push one durable local recording per pass. A global foreground runner calls
  // this independently of the Uploads screen, so field work can continue while
  // transfers happen and interrupted uploads recover when the app resumes.
  tick = async (): Promise<boolean> => {
    if (uploadInFlight) return false;
    const now = Date.now();
    const pending = localUploads().find(
      (item) =>
        item.status === 'UPLOADING' ||
        (item.status === 'PENDING' &&
          (!item.nextAttemptAt || new Date(item.nextAttemptAt).getTime() <= now)),
    );
    if (!pending) return false;
    uploadInFlight = true;
    const store = useDemoStore.getState();
    try {
      const media = store.media.find((item) => item.id === pending.mediaId);
      if (!media?.uri) {
        store.updateUpload(pending.id, {
          status: 'FAILED',
          lastError: 'The recording file is no longer on this device. Record the room again.',
        });
        return true;
      }
      const fileInfo = await LegacyFileSystem.getInfoAsync(media.uri);
      if (!fileInfo.exists) {
        store.updateUpload(pending.id, {
          status: 'FAILED',
          lastError: 'The recording file is no longer on this device. Record the room again.',
        });
        return true;
      }
      const { data } = await getSupabaseClient().auth.getSession();
      if (!data.session) throw new SessionExpiredError();
      const baseUrl = environment.apiBaseUrls[0] ?? environment.apiBaseUrl;
      if (!baseUrl)
        throw new Error('The TexasRenters API URL is not configured for this app build.');
      store.updateUpload(pending.id, { status: 'UPLOADING', progress: 0, lastError: undefined });
      // Additional labeled clips post to a separate endpoint that keeps the
      // primary walkthrough intact and carries the label/category metadata.
      const isAdditional = pending.recordingType === 'ADDITIONAL_ISSUE';
      const endpoint = isAdditional
        ? `/api/v1/technician/rooms/${encodeURIComponent(pending.roomId)}/videos`
        : `/api/v1/technician/rooms/${encodeURIComponent(pending.roomId)}/media`;
      const parameters: Record<string, string> = {
        // The media id is stable across retries, so the backend can
        // deduplicate re-sent recordings.
        idempotencyKey: media.id,
        durationSeconds: String(Math.max(1, Math.round(media.durationSeconds))),
      };
      if (!isAdditional && media.captureSummary) {
        parameters.captureSessionId = media.captureSummary.sessionId;
        parameters.capturePolicyVersion = media.captureSummary.policyVersion;
        parameters.coverageStatus = media.captureSummary.coverageStatus;
        parameters.sensorConfidence = media.captureSummary.sensorConfidence;
        parameters.clockwiseRotationDegrees = String(media.captureSummary.clockwiseRotationDegrees);
        parameters.counterClockwiseRotationDegrees = String(
          media.captureSummary.counterClockwiseRotationDegrees,
        );
        parameters.returnedToStart = String(media.captureSummary.returnedToStart);
        parameters.sensorSupported = String(media.captureSummary.sensorSupported);
        parameters.manualConfirmation = String(media.captureSummary.manualConfirmation);
        parameters.evidenceComplete = String(media.captureSummary.evidenceComplete);
        parameters.snapshotCount = String(media.captureSummary.snapshotCount);
        parameters.findingMarkerCount = String(media.captureSummary.findingMarkerCount);
        if (media.captureSummary.startHeadingDegrees !== undefined)
          parameters.startHeadingDegrees = String(media.captureSummary.startHeadingDegrees);
        if (media.captureSummary.endHeadingDegrees !== undefined)
          parameters.endHeadingDegrees = String(media.captureSummary.endHeadingDegrees);
      }
      // Moments the technician marked while the camera kept rolling. Sent as a
      // comma-separated list because the upload is multipart form data, where
      // every parameter is a string anyway.
      if (!isAdditional && media.frameMarkersMs?.length) {
        parameters.frameMarkersMs = media.frameMarkersMs.join(',');
      }
      if (isAdditional) {
        parameters.label = (pending.label ?? media.label ?? 'Additional clip').slice(0, 120);
        if (pending.category ?? media.category)
          parameters.category = (pending.category ?? media.category) as string;
        if (pending.relatedFindingId ?? media.relatedFindingId)
          parameters.relatedFindingId = (pending.relatedFindingId ??
            media.relatedFindingId) as string;
      }
      const task = LegacyFileSystem.createUploadTask(
        resolveApiUrl(baseUrl, endpoint),
        media.uri,
        {
          httpMethod: 'POST',
          uploadType: LegacyFileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: 'video/mp4',
          parameters,
          headers: { authorization: `Bearer ${data.session.access_token}` },
          // Stated explicitly rather than relying on the default: an in-flight
          // transfer must survive the technician locking the phone or switching
          // apps mid-room. The native session keeps going and retries through
          // connection drops; the promise settles when the app is next
          // foregrounded. Android ignores this and is always background.
          sessionType: LegacyFileSystem.FileSystemSessionType.BACKGROUND,
        },
        (progress) => {
          if (progress.totalBytesExpectedToSend > 0)
            useDemoStore.getState().updateUpload(pending.id, {
              progress: Math.min(0.99, progress.totalBytesSent / progress.totalBytesExpectedToSend),
            });
        },
      );
      const result = await task.uploadAsync();
      if (!result || result.status < 200 || result.status >= 300) {
        let message: string | undefined;
        try {
          message = (JSON.parse(result?.body ?? '{}') as { message?: string }).message;
        } catch {
          message = undefined;
        }
        if (!result || result.status >= 500) {
          this.deferForRetry(
            pending,
            message ?? 'The server is temporarily unavailable. Upload will retry automatically.',
          );
        } else {
          store.updateUpload(pending.id, {
            status: 'FAILED',
            lastError: message ?? `Upload failed (${result.status}). Tap retry to resend.`,
          });
        }
        return true;
      }
      // The backend now owns this recording; drop the local queue entry so the
      // uploads list shows the server-backed item instead.
      store.removeUpload(pending.id);
      return true;
    } catch (error) {
      this.deferForRetry(
        pending,
        error instanceof Error
          ? error.message
          : 'The network is unavailable. Upload will retry automatically.',
      );
      return true;
    } finally {
      uploadInFlight = false;
    }
  };

  private updateLocal(id: string, update: Partial<UploadItem>) {
    if (!localUploads().some((item) => item.id === id))
      return unavailable('Server-backed uploads are managed by the TexasRenters platform.');
    useDemoStore.getState().updateUpload(id, update);
  }

  private deferForRetry(item: UploadItem, message: string) {
    const attemptCount = (item.attemptCount ?? 0) + 1;
    const delaySeconds = Math.min(60, 2 ** Math.min(attemptCount, 6));
    useDemoStore.getState().updateUpload(item.id, {
      status: 'PENDING',
      progress: 0,
      attemptCount,
      nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
      lastError: `${message} Saved safely on this device; retrying automatically.`,
    });
  }
}

function localUploads() {
  const state = useDemoStore.getState();
  return state.uploads.filter(
    (item) => item.id.startsWith('local-upload-') && item.ownerUserId === state.selectedUserId,
  );
}

function withLocalRoomState(room: z.infer<typeof roomSchema>) {
  const state = useDemoStore.getState();
  const upload = state.uploads.find(
    (item) =>
      item.ownerUserId === state.selectedUserId &&
      item.id.startsWith('local-upload-') &&
      item.roomId === room.id,
  );
  const hasLocalRecording = state.media.some(
    (item) =>
      item.ownerUserId === state.selectedUserId &&
      item.id.startsWith('local-media-') &&
      item.roomId === room.id,
  );
  if (!upload && !hasLocalRecording) return room;
  return {
    ...room,
    completionStatus:
      room.completionStatus === 'COMPLETED' || room.completionStatus === 'SKIPPED'
        ? room.completionStatus
        : ('RECORDING_SAVED' as const),
    uploadStatus: upload?.status ?? room.uploadStatus,
    processingStatus: upload?.processingStatus ?? room.processingStatus,
  };
}

export class ApiFindingRepository implements FindingRepository {
  async list(inspectionId?: string, kind: FindingKind = 'DEFECTS') {
    if (!inspectionId) return [];
    // `kind` is part of the key for the same reason it is part of the
    // react-query key: defects and summaries come from one endpoint, and a
    // shared key would let one overwrite the other in the cache.
    const payload = await cachedApiRecord(
      `findings:${inspectionId}:${kind}`,
      z.object({ items: z.array(findingSchema) }),
      () =>
        getJson(
          `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/findings?page=1&pageSize=100&kind=${kind}`,
        ),
    );
    return payload.items;
  }
  async get(id: string, inspectionId?: string) {
    if (!inspectionId) return unavailable('Open findings from their assigned inspection.');
    // Search the kinds the app actually fetches, rather than kind=ALL: no
    // screen requests ALL, so it is never in the offline cache and a finding
    // opened without signal would fail even though its list is cached.
    // Defects first — that is what the lists a technician taps are made of.
    for (const kind of ['DEFECTS', 'SUMMARIES'] as const) {
      const finding = (await this.list(inspectionId, kind)).find((item) => item.id === id);
      if (finding) return finding;
    }
    throw new Error('This finding is no longer available for this inspection.');
  }
  approve = async () => unavailable('Technicians cannot approve AI findings.');
  edit = async () => unavailable('Technicians cannot edit AI findings.');
  reject = async () => unavailable('Technicians cannot reject AI findings.');
  requestReinspection = async () => unavailable('Technicians cannot request reinspection.');
}
