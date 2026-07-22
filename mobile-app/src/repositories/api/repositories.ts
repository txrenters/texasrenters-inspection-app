import * as LegacyFileSystem from 'expo-file-system/legacy';

import { getSupabaseClient } from '../../auth/supabase';
import { environment } from '../../config/environment';
import { pushDeviceStorage } from '../../realtime/push-device-storage';
import type { LocalMedia, UploadItem } from '../../domain/models';
import { useDemoStore } from '../../stores/demo.store';
import type {
  AuthRepository,
  CatalogRepository,
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
  type: z.enum(['MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT']),
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
});
const roomSchema = z.object({
  id: z.string(),
  inspectionId: z.string(),
  propertyAreaId: z.string(),
  name: z.string(),
  floorName: z.string(),
  order: z.number(),
  isRequired: z.boolean(),
  inspectionType: z.enum(['MOVE_IN', 'OCCUPIED', 'BACK_TO_MARKET', 'MOVE_OUT']),
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
});
const findingSchema = z.object({
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
    'INSUFFICIENT_EVIDENCE',
    'NORMAL_WEAR',
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
});
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

export async function requestJson(path: string, options: RequestInit = {}): Promise<unknown> {
  if (!environment.apiBaseUrl)
    throw new Error('The TexasRenters API URL is not configured for this app build.');
  const { data } = await getSupabaseClient().auth.getSession();
  if (!data.session) throw new Error('Your session has expired. Sign in again.');
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
        throw new Error(
          'The TexasRenters API did not respond in time. Check the server and retry.',
        );
      throw new Error('Cannot connect to the TexasRenters API. Check the server and retry.');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (hasFallback && [502, 503, 504].includes(response.status)) continue;
      throw new Error(payload?.message ?? `TexasRenters API request failed (${response.status}).`);
    }
    return response.status === 204 ? undefined : response.json();
  }
  throw new Error('Cannot connect to the TexasRenters API. Check the server and retry.');
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
    const profile = z
      .object({
        id: z.string(),
        displayName: z.string(),
        roles: z.array(z.string()),
        mustChangePassword: z.boolean(),
      })
      .parse(await getJson('/api/v1/auth/me'));
    if (!profile.roles.includes('INSPECTION_TECHNICIAN')) {
      await getSupabaseClient().auth.signOut({ scope: 'local' });
      throw new Error('TexasRenters Inspection Mobile is available only to technicians.');
    }
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
    return propertySchema.parse(
      await getJson(`/api/v1/technician/properties/${encodeURIComponent(id)}`),
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
    return z
      .object({
        today: z.number(),
        inProgress: z.number(),
        completed: z.number(),
        pendingUploads: z.number(),
        assignments: z.array(inspectionSchema),
        recent: z.array(inspectionSchema),
      })
      .parse(await getJson('/api/v1/technician/dashboard'));
  }
  async list(filters: { status?: string; search?: string } = {}) {
    const query = new URLSearchParams({ page: '1', pageSize: '25' });
    if (filters.status) query.set('status', filters.status);
    if (filters.search?.trim()) query.set('search', filters.search.trim());
    return z
      .object({ items: z.array(inspectionSchema) })
      .parse(await getJson(`/api/v1/technician/inspections?${query.toString()}`)).items;
  }
  async get(id: string) {
    return inspectionSchema.parse(
      await getJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}`),
    );
  }
  async context(id: string) {
    return z
      .object({
        inspection: inspectionSchema,
        property: propertySchema,
        rooms: z.array(roomSchema),
        pendingReviewCount: z.number(),
      })
      .parse(await getJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/context`));
  }
  async start(id: string) {
    return inspectionSchema.parse(
      await writeJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/start`, 'POST'),
    );
  }
  async complete(id: string) {
    return inspectionSchema.parse(
      await writeJson(`/api/v1/technician/inspections/${encodeURIComponent(id)}/complete`, 'POST'),
    );
  }
  async rooms(inspectionId: string) {
    return z
      .array(roomSchema)
      .parse(
        await getJson(`/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/rooms`),
      );
  }
  async room(roomId: string) {
    return roomSchema.parse(
      await getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}`),
    );
  }
  async updateRoomNote(roomId: string, note: string) {
    return roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/note`, 'PATCH', {
        note,
      }),
    );
  }
  async skipRoom(roomId: string, reason: string) {
    return roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/skip`, 'POST', {
        reason,
      }),
    );
  }
  async completeRoom(roomId: string) {
    return roomSchema.parse(
      await writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/complete`, 'POST'),
    );
  }
}

export class ApiFloorPlanRepository implements FloorPlanRepository {
  async get(propertyId: string) {
    const plan = floorPlanSchema.parse(
      await getJson(`/api/v1/technician/properties/${encodeURIComponent(propertyId)}/floor-plan`),
    );
    if (!plan) return null;
    const { data } = await getSupabaseClient().auth.getSession();
    if (!data.session) throw new Error('Your session has expired. Sign in again.');
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
      .media.filter((item) => item.roomId === roomId && item.id.startsWith('local-media-'));
    let records: Array<{
      id: string;
      inspectionId: string;
      inspectionAreaId: string;
      durationSeconds: number;
      createdAt: string;
    }>;
    try {
      records = z
        .array(
          z.object({
            id: z.string(),
            inspectionId: z.string(),
            inspectionAreaId: z.string(),
            durationSeconds: z.number(),
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
      uri: '',
      durationSeconds: record.durationSeconds,
      estimatedSizeMb: 0,
      recordedAt: record.createdAt,
      note: '',
    }));
    return [
      ...localRecords,
      ...remoteRecords.filter(
        (remote) => !localRecords.some((local) => local.id === remote.id),
      ),
    ];
  }
  async save(input: Omit<LocalMedia, 'id' | 'recordedAt'>) {
    const media: LocalMedia = {
      ...input,
      id: `local-media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      recordedAt: new Date().toISOString(),
    };
    useDemoStore.getState().saveMedia(media);
    return media;
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
    const existing = localUploads().find((item) => item.mediaId === media.id);
    if (existing) return existing;
    const item: UploadItem = {
      id: `local-upload-${media.id}`,
      mediaId: media.id,
      inspectionId: media.inspectionId,
      roomId: media.roomId,
      propertyAddress: media.propertyAddress ?? 'Assigned property',
      roomName: media.roomName ?? 'Room evidence',
      durationSeconds: media.durationSeconds,
      estimatedSizeMb: media.estimatedSizeMb,
      status: 'PENDING',
      progress: 0,
      processingStatus: 'NOT_STARTED',
      processingProgress: 0,
      createdAt: new Date().toISOString(),
    };
    useDemoStore.getState().enqueueUpload(item);
    void this.tick();
    return item;
  }
  async pause(id: string) {
    this.updateLocal(id, { status: 'PAUSED' });
  }
  async resume(id: string) {
    this.updateLocal(id, { status: 'PENDING', lastError: undefined });
    void this.tick();
  }
  async retry(id: string) {
    this.updateLocal(id, { status: 'PENDING', progress: 0, lastError: undefined });
    void this.tick();
  }
  async retryProcessing(id: string) {
    this.updateLocal(id, { processingStatus: 'NOT_STARTED', processingProgress: 0 });
  }
  async remove(id: string) {
    if (!localUploads().some((item) => item.id === id))
      return unavailable('Server-backed uploads cannot be removed from the device.');
    useDemoStore.getState().removeUpload(id);
  }

  // Pushes one pending recording per pass; the uploads/processing screens call
  // this on an interval, so the queue drains even after transient failures.
  tick = async () => {
    if (uploadInFlight) return;
    const pending = localUploads().find((item) => item.status === 'PENDING');
    if (!pending) return;
    uploadInFlight = true;
    const store = useDemoStore.getState();
    try {
      const media = store.media.find((item) => item.id === pending.mediaId);
      if (!media?.uri) {
        store.updateUpload(pending.id, {
          status: 'FAILED',
          lastError: 'The recording file is no longer on this device. Record the room again.',
        });
        return;
      }
      const fileInfo = await LegacyFileSystem.getInfoAsync(media.uri);
      if (!fileInfo.exists) {
        store.updateUpload(pending.id, {
          status: 'FAILED',
          lastError: 'The recording file is no longer on this device. Record the room again.',
        });
        return;
      }
      const { data } = await getSupabaseClient().auth.getSession();
      if (!data.session) throw new Error('Your session has expired. Sign in again.');
      const baseUrl = environment.apiBaseUrls[0] ?? environment.apiBaseUrl;
      if (!baseUrl) throw new Error('The TexasRenters API URL is not configured for this app build.');
      store.updateUpload(pending.id, { status: 'UPLOADING', progress: 0, lastError: undefined });
      const task = LegacyFileSystem.createUploadTask(
        resolveApiUrl(baseUrl, `/api/v1/technician/rooms/${encodeURIComponent(pending.roomId)}/media`),
        media.uri,
        {
          httpMethod: 'POST',
          uploadType: LegacyFileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: 'video/mp4',
          parameters: {
            // The media id is stable across retries, so the backend can
            // deduplicate re-sent recordings.
            idempotencyKey: media.id,
            durationSeconds: String(Math.max(1, Math.round(media.durationSeconds))),
          },
          headers: { authorization: `Bearer ${data.session.access_token}` },
        },
        (progress) => {
          if (progress.totalBytesExpectedToSend > 0)
            useDemoStore
              .getState()
              .updateUpload(pending.id, {
                progress: Math.min(
                  0.99,
                  progress.totalBytesSent / progress.totalBytesExpectedToSend,
                ),
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
        store.updateUpload(pending.id, {
          status: 'FAILED',
          lastError:
            message ?? `Upload failed (${result?.status ?? 'no response'}). Tap retry to resend.`,
        });
        return;
      }
      // The backend now owns this recording; drop the local queue entry so the
      // uploads list shows the server-backed item instead.
      store.removeUpload(pending.id);
      store.removeMedia(pending.mediaId);
    } catch (error) {
      useDemoStore.getState().updateUpload(pending.id, {
        status: 'FAILED',
        lastError:
          error instanceof Error
            ? error.message
            : 'Upload failed unexpectedly. It will retry when you tap retry.',
      });
    } finally {
      uploadInFlight = false;
    }
  };

  private updateLocal(id: string, update: Partial<UploadItem>) {
    if (!localUploads().some((item) => item.id === id))
      return unavailable('Server-backed uploads are managed by the TexasRenters platform.');
    useDemoStore.getState().updateUpload(id, update);
  }
}

function localUploads() {
  return useDemoStore.getState().uploads.filter((item) => item.id.startsWith('local-upload-'));
}

export class ApiFindingRepository implements FindingRepository {
  async list(inspectionId?: string) {
    if (!inspectionId) return [];
    return z
      .object({ items: z.array(findingSchema) })
      .parse(
        await getJson(
          `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/findings?page=1&pageSize=100`,
        ),
      ).items;
  }
  async get(id: string, inspectionId?: string) {
    if (!inspectionId) return unavailable('Open findings from their assigned inspection.');
    const findings = await this.list(inspectionId);
    const finding = findings.find((item) => item.id === id);
    if (!finding) throw new Error('This finding is no longer available for this inspection.');
    return finding;
  }
  approve = async () => unavailable('Technicians cannot approve AI findings.');
  edit = async () => unavailable('Technicians cannot edit AI findings.');
  reject = async () => unavailable('Technicians cannot reject AI findings.');
  requestReinspection = async () => unavailable('Technicians cannot request reinspection.');
}
