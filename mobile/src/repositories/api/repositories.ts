import * as LegacyFileSystem from 'expo-file-system/legacy';

import { getSession, signIn, signOut } from '../../auth/session';
import { environment } from '../../config/environment';
import { pushDeviceStorage } from '../../realtime/push-device-storage';
import type {
  ChecklistAssessment,
  InspectionStatus,
  LocalMedia,
  PhotoCaptureType,
  RoomCompletionStatus,
  UploadItem,
} from '../../domain/models';
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
  UpdateAreaInput,
  AuthRepository,
  CatalogRepository,
  FindingKind,
  FindingRepository,
  FloorPlanRepository,
  InspectionListFilters,
  InspectionPage,
  InspectionRepository,
  MediaRepository,
  PropertyRepository,
  UploadRepository,
} from '../contracts';
import { INSPECTION_PAGE_SIZE } from '../contracts';
import { QueuedOfflineError, queueOnConnectionFailure } from './offline-writes';
import {
  runStreamUpload,
  type StreamUploadSession,
} from '../../media/stream-upload-runner';
import type { VideoPlaybackResponse } from '../../media/playback-source';
import { resolveApiUrl } from '@texasrenters/shared';


import { z } from 'zod';

/**
 * A string the API may send as `null`, `undefined`, or omit entirely.
 *
 * These are all nullable columns, and Prisma serialises them as `null` — which
 * `nullableString` rejects, because optional means *absent*, not null.
 * A rejection fails the whole response, so one null reviewer note blanked the
 * entire findings list rather than that one field.
 *
 * Normalised to `undefined` so every consumer keeps the type it already had.
 */
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);

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
  baselineScheduledAt: nullableString,
  scheduledAt: z.string(),
  assignedUserId: z.string(),
  // Permissive for the same reason as captureType, and it had already broken:
  // this enum listed six statuses while the server has ten. TECHNICIAN_SUBMITTED,
  // UNDER_REVIEW, TBD and FOLLOW_UP_REQUIRED were all missing, and the list is
  // scoped to "not CANCELLED" — so one submitted inspection failed the parse for
  // the *entire* list, not one row. That is the screen a technician uses to find
  // their work, and the "Submitted" chip exists precisely to show those records.
  //
  // An unrecognised status now reaches inspectionStatusPresentation, which
  // already renders it as "Unknown" rather than implying the work is finished.
  status: z.string().transform((value) => value as InspectionStatus),
  priority: z.enum(['STANDARD', 'HIGH']),
  roomIds: z.array(z.string()),
  // Defaulted rather than required: a cached inspection written before this
  // field existed must still parse, or the whole record is discarded.
  allowTechnicianAreaCapture: z.boolean().default(false),
  // Why the office sent this back. Optional: most inspections were never
  // reopened, and an absent reason is not an error.
  reopenReason: z.string().optional(),
  propertyNotes: z.string(),
  property: propertySchema.pick({ id: true, address: true, cityStateZip: true, imageTone: true }),
  progress: z.object({
    completed: z.number(),
    total: z.number(),
    hasFailedUpload: z.boolean(),
  }),
  updatedAt: nullableString,
});
/**
 * A page of inspections, `total` included.
 *
 * The old schema was `z.object({ items })`, which parsed the envelope and threw
 * the count away — so the header could only count rows in hand. Carrying it
 * changes the cached shape, which is why CACHE_SCHEMA_VERSION moved with this.
 */
export const inspectionPageSchema = z.object({
  items: z.array(inspectionSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  totalPages: z.number(),
});

// Exported for the offline round-trip test: rooms are cached and re-parsed
// from their own stored output, so this shape has to survive the trip.
export const roomSchema = z.object({
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
  // Permissive for the same reason as `status` above: this enum just grew two
  // members the server can send, and a strict list here would have rejected
  // the whole area rather than one field. The screens fall back to
  // NOT_STARTED for anything they do not recognise.
  completionStatus: z
    .string()
    .transform((value) => value as RoomCompletionStatus),
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
  note: nullableString,
  skipReason: nullableString,
  // Optional, not defaulted: a room cached before this field existed was never
  // confirmed, and absent is exactly that. Round-trips cleanly because the
  // mapper drops it rather than writing null.
  summaryConfirmedAt: nullableString,
  // Defaulted false rather than optional: this one gates submission, and a room
  // from an older backend that cannot report it is not "maybe still analyzing",
  // it is a room nothing is waiting on. Absent must not block.
  analysisPending: z.boolean().default(false),
  // Defaults keep older cached rooms (pre-Phase-2) parseable.
  environment: z.enum(['INDOOR', 'OUTDOOR', 'SEMI_OUTDOOR']).default('INDOOR'),
  category: z.string().nullable().optional(),
  source: z.string().default('AI_FLOOR_PLAN'),
  areaStatus: z.enum(['DRAFT', 'APPROVED', 'REJECTED']).default('APPROVED'),
  updatedAt: nullableString,
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
  reviewerNotes: nullableString,
  updatedAt: nullableString,
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
/**
 * A checklist item and how this inspection found it.
 *
 * The three axes are **nullable tri-states**, not booleans: null means nobody
 * assessed that axis, which is a different claim from "No". The printed report
 * leaves such cells blank, so defaulting them to false here would publish a
 * defect the technician never observed.
 */
export const checklistSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    keywords: z.array(z.string()).default([]),
    // Defaulted null so a response from a backend that predates assessments
    // still parses — as unassessed, which is exactly what it is.
    isClean: z.boolean().nullable().default(null),
    isUndamaged: z.boolean().nullable().default(null),
    isWorking: z.boolean().nullable().default(null),
    comment: z.string().nullable().default(null),
    recordedAt: z.string().nullable().default(null),
  }),
);

/**
 * What the office has asked this technician to go back and capture.
 *
 * `items` empty means the whole area — the server resolves checklist item ids
 * to labels before sending, so the app never has to join against a list it may
 * not have loaded.
 */
export const openEvidenceRequestSchema = z.array(
  z.object({
    id: z.string(),
    inspectionId: z.string(),
    roomId: z.string(),
    roomName: z.string(),
    propertyName: z.string(),
    unitName: z.string().nullable(),
    note: z.string(),
    requestedAt: z.string(),
  }),
);

export const evidenceRequestSchema = z.array(
  z.object({
    id: z.string(),
    roomId: z.string(),
    roomName: z.string(),
    note: z.string(),
    requestedAt: z.string(),
    items: z.array(z.string()).default([]),
  }),
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
/**
 * Ask the backend to reserve a direct-to-Cloudflare upload.
 *
 * Returns null when the deployment has no Stream credentials, which the runner
 * reads as "keep using the multipart path" rather than as a failure. Everything
 * else throws, because a technician standing in a unit needs the upload retried,
 * not silently downgraded.
 */
async function createStreamUploadSession(input: {
  baseUrl: string;
  accessToken: string;
  inspectionAreaId: string;
  recordingType: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  durationSeconds: number;
  localQueueId: string;
  idempotencyKey: string;
}): Promise<StreamUploadSession | null> {
  const { baseUrl, accessToken, ...body } = input;
  const url = resolveApiUrl(baseUrl, '/api/v1/inspection-videos/upload-session');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    /**
     * The only fetch in the upload path that had no catch, so React Native's
     * bare "Network request failed" reached the queue verbatim and was shown
     * on every retry. That string names no host, no stage and no cause, which
     * makes a queue stuck against a wrong or unreachable API indistinguishable
     * from one stuck against Cloudflare — the two have completely different
     * fixes.
     *
     * Reported as an ApiConnectionError so the queue treats it as transient and
     * keeps the recording, and so the offline cache path recognises it.
     */
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiConnectionError(
      `Could not reach ${new URL(url).host} to start the upload (${reason}). ` +
        'The recording is safe on this device and will retry.',
    );
  }
  if (response.status === 503) return null;
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      detail?.message ?? `The upload could not be started (${response.status} from ${new URL(url).host}).`,
    );
  }
  return (await response.json()) as StreamUploadSession;
}

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
  // Refreshes in place when the token is close to expiry. This is the only
  // thing that keeps a token alive — nothing refreshes on a timer.
  const session = await getSession();
  if (!session) throw new SessionExpiredError();
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
          authorization: `Bearer ${session.accessToken}`,
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
const writeJson = (path: string, method: 'POST' | 'PATCH' | 'PUT', body?: object) =>
  requestJson(path, { method, body: body ? JSON.stringify(body) : undefined });
/**
 * The same request path a queued write took when it first failed, exported so
 * the drain replays it exactly rather than through a second implementation
 * that could drift from this one.
 */
export const sendQueuedWrite = (path: string, method: string, body: unknown) =>
  requestJson(path, { method, body: body ? JSON.stringify(body) : undefined });
const unavailable = (message: string): never => {
  throw new Error(message);
};

export class ApiAuthRepository implements AuthRepository {
  listDemoUsers = async () => unavailable('Demo accounts are disabled in this app build.');
  signIn = async () => unavailable('Demo sign-in is disabled in this app build.');
  async signInWithPassword(email: string, password: string) {
    await signIn(email, password);
    const user = await this.currentUser();
    if (!user) throw new Error('No active TexasRenters profile or organization membership.');
    return user;
  }
  async changeRequiredPassword(password: string) {
    await writeJson('/api/v1/auth/change-required-password', 'POST', { password });
    // The password changed, so every session opened with the old one is dead
    // server-side; drop the local tokens rather than let the next request
    // discover it.
    await signOut();
  }
  /**
   * Ask the office to mail a reset link.
   *
   * The link points at the admin console, which is where the form lives — the
   * app registers no deep-link handler, so it could not receive one.
   *
   * Reachable only through `usePasswordReset`, which no screen renders — the
   * sign-in screen offers no "forgot password" route, so a technician asks the
   * office. Kept because this is the endpoint that route should call.
   */
  async resetPassword(email: string) {
    await writeJson('/api/v1/auth/request-password-reset', 'POST', { email });
  }
  async currentUser() {
    const session = await getSession();
    if (!session) return null;
    const profile = await cachedApiRecord('auth:profile', profileSchema, () =>
      getJson('/api/v1/auth/me'),
    );
    if (!profile.roles.includes('INSPECTION_TECHNICIAN')) {
      await signOut();
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
    await signOut();
    useDemoStore.getState().signOut();
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
  async listPage(filters: InspectionListFilters = {}): Promise<InspectionPage> {
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? INSPECTION_PAGE_SIZE;
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    // One `status` carrying the whole set, which the backend splits. A chip is
    // a group of statuses, so filtering it server-side is the only way the
    // chip sees work beyond the first page.
    if (filters.statuses?.length) query.set('status', filters.statuses.join(','));
    if (filters.search?.trim()) query.set('search', filters.search.trim());
    return cachedApiRecord(`inspections:${query.toString()}`, inspectionPageSchema, () =>
      getJson(`/api/v1/technician/inspections?${query.toString()}`),
    );
  }
  async list(filters: InspectionListFilters = {}) {
    return (await this.listPage(filters)).items;
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
  async evidenceRequests(inspectionId: string) {
    return cachedApiRecord(`evidenceRequests:${inspectionId}`, evidenceRequestSchema, () =>
      getJson(
        `/api/v1/technician/inspections/${encodeURIComponent(inspectionId)}/evidence-requests`,
      ),
    );
  }
  async openEvidenceRequests() {
    // Cached under a key with no inspection id: this is the whole outstanding
    // list, and it is what the requests tab reads offline.
    return cachedApiRecord('openEvidenceRequests', openEvidenceRequestSchema, () =>
      getJson('/api/v1/technician/evidence-requests'),
    );
  }
  async resolveEvidenceRequest(requestId: string) {
    await writeJson(
      `/api/v1/technician/evidence-requests/${encodeURIComponent(requestId)}/resolve`,
      'POST',
    );
  }
  async roomChecklist(roomId: string) {
    return cachedApiRecord(`roomChecklist:${roomId}`, checklistSchema, () =>
      getJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/checklist`),
    );
  }
  /**
   * Records how one checklist item was found.
   *
   * Queued when the network is gone, like a skip or a note — a technician
   * standing in a unit with no signal is exactly who is filling this in, and
   * losing the assessment would mean walking the room again.
   *
   * The queue id is per item, so a re-score before the queue drains replaces
   * the pending entry rather than sending two conflicting assessments.
   */
  async recordChecklistItem(roomId: string, itemId: string, assessment: ChecklistAssessment) {
    const body = {
      isClean: assessment.isClean ?? null,
      isUndamaged: assessment.isUndamaged ?? null,
      isWorking: assessment.isWorking ?? null,
      comment: assessment.comment ?? null,
      // Where in the recording it was answered. Built explicitly here, so a
      // field added to ChecklistAssessment and not to this object is silently
      // dropped before it ever leaves the phone.
      videoTimestampSeconds: assessment.videoTimestampSeconds ?? null,
    };
    try {
      await queueOnConnectionFailure(
        {
          id: `checklist:${roomId}:${itemId}`,
          kind: 'checklist-assessment',
          payload: { roomId, itemId, ...body },
        },
        () =>
          writeJson(
            `/api/v1/technician/rooms/${encodeURIComponent(roomId)}/checklist/${encodeURIComponent(itemId)}`,
            'PUT',
            body,
          ),
      );
    } catch (error) {
      /**
       * A queued write still has to show on screen.
       *
       * Offline is the normal case for this form — a technician in a unit with
       * no signal is exactly who is filling it in. Letting the error through
       * untouched would leave the cached list saying "unassessed", so their
       * answers would visibly vanish the moment they looked away, even though
       * the queue is holding them safely.
       */
      if (error instanceof QueuedOfflineError)
        await updateExistingApiRecord(`roomChecklist:${roomId}`, checklistSchema, (current) =>
          current.map((item) => (item.id === itemId ? { ...item, ...body } : item)),
        );
      throw error;
    }
    // Re-read rather than patching the cached list by hand: the server is the
    // authority on what was stored, including the trimmed comment.
    return this.roomChecklist(roomId);
  }
  /**
   * Corrects an area this technician added.
   *
   * Not queued offline like a note or a skip: the server decides whether the
   * area is theirs to change, and a rename held on the device would look
   * accepted for hours before being refused.
   */
  async updateArea(roomId: string, input: UpdateAreaInput) {
    const room = withLocalRoomState(
      roomSchema.parse(
        await writeJson(
          `/api/v1/technician/rooms/${encodeURIComponent(roomId)}/area`,
          'PATCH',
          input,
        ),
      ),
    );
    await this.persistRoom(room);
    return room;
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
  // Both are held rather than lost when the network is gone, and both are safe
  // to replay because they set a value: sending either twice lands on the same
  // state. An appending write could not be queued this way.
  async updateRoomNote(roomId: string, note: string) {
    const room = roomSchema.parse(
      await queueOnConnectionFailure(
        { id: `note:${roomId}`, kind: 'room-note', payload: { roomId, note } },
        () =>
          writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/note`, 'PATCH', {
            note,
          }),
      ),
    );
    await this.persistRoom(room);
    return room;
  }
  async skipRoom(roomId: string, reason: string) {
    const room = roomSchema.parse(
      await queueOnConnectionFailure(
        { id: `skip:${roomId}`, kind: 'room-skip', payload: { roomId, reason } },
        () =>
          writeJson(`/api/v1/technician/rooms/${encodeURIComponent(roomId)}/skip`, 'POST', {
            reason,
          }),
      ),
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
  /**
   * Records that the technician read the AI summary and it matches the area.
   *
   * Queued like a skip, because losing signal between reading the summary and
   * tapping confirm should not cost the technician the attestation.
   */
  async confirmRoomSummary(roomId: string) {
    const room = roomSchema.parse(
      await queueOnConnectionFailure(
        { id: `confirm-summary:${roomId}`, kind: 'room-confirm-summary', payload: { roomId } },
        () =>
          writeJson(
            `/api/v1/technician/rooms/${encodeURIComponent(roomId)}/confirm-summary`,
            'POST',
          ),
      ),
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
    const session = await getSession();
    if (!session) throw new SessionExpiredError();
    return {
      ...plan,
      contentSources: environment.apiBaseUrls.map((baseUrl) => ({
        uri: resolveApiUrl(baseUrl, plan.contentPath),
        headers: { authorization: `Bearer ${session.accessToken}` },
      })),
    };
  }
  rooms = async (_propertyId: string, inspectionId: string) =>
    new ApiInspectionRepository().rooms(inspectionId);
}

export class ApiMediaRepository implements MediaRepository {
  async playback(mediaId: string) {
    return (await getJson(
      `/api/v1/inspection-videos/${encodeURIComponent(mediaId)}/playback`,
    )) as VideoPlaybackResponse;
  }

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
      const session = await getSession();
      if (!session) throw new SessionExpiredError();
      const baseUrl = environment.apiBaseUrls[0] ?? environment.apiBaseUrl;
      if (!baseUrl)
        throw new Error('The TexasRenters API URL is not configured for this app build.');
      store.updateUpload(pending.id, {
        status: 'UPLOADING',
        // Resuming, so progress starts where Cloudflare confirmed it, not at 0.
        progress: pending.uploadedBytes && pending.fileSize ? pending.progress : 0,
        lastError: undefined,
      });

      // Cloudflare Stream first: the bytes go device → Cloudflare and never
      // through this backend. `unavailable` means the deployment has no Stream
      // credentials yet, in which case the original multipart path below still
      // runs — video capture must not stop while an account is being set up.
      const streamOutcome = await runStreamUpload({
        item: pending,
        localUri: media.uri,
        fileSize: fileInfo.size ?? 0,
        mimeType: 'video/mp4',
        filename: `${pending.roomName || 'recording'}.mp4`.replace(/\s+/g, '-').toLowerCase(),
        signal: undefined,
        createSession: () =>
          createStreamUploadSession({
            baseUrl,
            accessToken: session.accessToken,
            inspectionAreaId: pending.roomId,
            recordingType: pending.recordingType ?? 'PRIMARY_AREA',
            filename: `${pending.roomName || 'recording'}.mp4`,
            mimeType: 'video/mp4',
            fileSize: fileInfo.size ?? 0,
            durationSeconds: Math.max(1, Math.round(media.durationSeconds)),
            localQueueId: pending.id,
            idempotencyKey: media.id,
          }),
        persist: (patch) => store.updateUpload(pending.id, patch),
      });

      if (streamOutcome.kind === 'uploaded') {
        // Uploaded, not ready: Cloudflare still has to encode it. Claiming
        // completion here would tell a technician their evidence was viewable
        // when it is not.
        store.updateUpload(pending.id, {
          status: 'COMPLETED',
          progress: 100,
          // The transfer is done; the video is not. VIDEO_PROCESSING is the
          // existing vocabulary for "Cloudflare still has work to do", and
          // saying READY here would show a technician a playable recording that
          // is not yet playable.
          processingStatus: 'VIDEO_PROCESSING',
          lastError: undefined,
        });
        return true;
      }
      if (streamOutcome.kind === 'failed') {
        store.updateUpload(pending.id, {
          status: streamOutcome.retryable ? 'PENDING' : 'FAILED',
          lastError: streamOutcome.message,
          attemptCount: (pending.attemptCount ?? 0) + 1,
          // Same curve as `deferForRetry`, but progress is deliberately not
          // reset: the bytes Cloudflare confirmed are still there, and showing
          // 0% would tell a technician a 40-minute upload had been thrown away.
          ...(streamOutcome.retryable
            ? {
                nextAttemptAt: new Date(
                  Date.now() + Math.min(60, 2 ** Math.min((pending.attemptCount ?? 0) + 1, 6)) * 1_000,
                ).toISOString(),
              }
            : {}),
        });
        return true;
      }
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
          headers: { authorization: `Bearer ${session.accessToken}` },
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
