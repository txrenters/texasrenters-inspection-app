import type {
  AddAreaInput,
  AuthRepository,
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
import type { DemoRole, DemoUser, Finding, InspectionRoom, LocalMedia } from '../../domain/models';
import { useDemoStore } from '../../stores/demo.store';
import { isRoomSummary } from '../../utils/ai-review';
import { demoUsers, inspections, properties, rooms } from './data';

async function mockDelay() {
  if (process.env.NODE_ENV === 'test') return;
  await new Promise((resolve) => setTimeout(resolve, 280 + Math.round(Math.random() * 180)));
}

function ensureMockAvailable() {
  if (useDemoStore.getState().mockErrorEnabled) {
    throw new Error('Demo data is temporarily unavailable. Turn off the mock error in Settings.');
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`${label} is unavailable in this demo.`);
  return value;
}

function mergedRoom(room: InspectionRoom) {
  return { ...room, ...useDemoStore.getState().roomOverrides[room.id] };
}

export class MockAuthRepository implements AuthRepository {
  async listDemoUsers() {
    await mockDelay();
    return demoUsers;
  }
  async signIn(role: DemoRole) {
    await mockDelay();
    const user = required(
      demoUsers.find((candidate) => candidate.role === role),
      'Demo user',
    );
    useDemoStore.getState().selectUser(user.id);
    return user;
  }
  async signInWithPassword(): Promise<DemoUser> {
    throw new Error('Email sign-in is available only in API mode.');
  }
  async changeRequiredPassword() {
    throw new Error('Temporary passwords are unavailable in Demo Mode.');
  }
  async resetPassword() {
    throw new Error('Password reset is available only in API mode.');
  }
  async currentUser() {
    const id = useDemoStore.getState().selectedUserId;
    return demoUsers.find((candidate) => candidate.id === id) ?? null;
  }
  async signOut() {
    useDemoStore.getState().signOut();
  }
}

export class MockPropertyRepository implements PropertyRepository {
  async list() {
    await mockDelay();
    ensureMockAvailable();
    return properties;
  }
  async get(id: string) {
    await mockDelay();
    ensureMockAvailable();
    return required(
      properties.find((property) => property.id === id),
      'Property',
    );
  }
}

export class MockInspectionRepository implements InspectionRepository {
  /**
   * No route from a fixture. A route is measured from a live position, and
   * inventing one would put a plausible-looking drive time in front of somebody
   * with no way to tell it was fabricated.
   */
  async route() {
    return {
      technicianId: 'mock-technician',
      origin: null,
      stops: [],
      legs: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      unroutable: [],
    };
  }
  async dashboard() {
    await mockDelay();
    ensureMockAvailable();
    const uploads = useDemoStore.getState().uploads;
    return {
      today: inspections.filter((item) => item.scheduledAt.startsWith('2026-07-17')).length,
      inProgress: inspections.filter((item) => item.status === 'IN_PROGRESS').length,
      completed: inspections.filter((item) => item.status === 'COMPLETED').length,
      pendingUploads: uploads.filter((item) => item.status !== 'COMPLETED').length,
      assignments: inspections.filter((item) => item.scheduledAt.startsWith('2026-07-17')),
      recent: inspections.filter((item) => item.status === 'COMPLETED').slice(0, 2),
    };
  }
  async listPage(filters: InspectionListFilters = {}): Promise<InspectionPage> {
    await mockDelay();
    ensureMockAvailable();
    const search = filters.search?.trim().toLowerCase();
    // Mirrors the server: filter first, then slice. Filtering after the slice
    // is the bug this whole change is about, so the demo must not model it.
    const matched = inspections.filter(
      (inspection) =>
        (!filters.statuses?.length || filters.statuses.includes(inspection.status)) &&
        (!search || inspection.property.address.toLowerCase().includes(search)),
    );
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? INSPECTION_PAGE_SIZE;
    return {
      items: matched.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: matched.length,
      totalPages: Math.max(1, Math.ceil(matched.length / pageSize)),
    };
  }
  async list(filters: InspectionListFilters = {}) {
    return (await this.listPage(filters)).items;
  }
  async get(id: string) {
    await mockDelay();
    ensureMockAvailable();
    return required(
      inspections.find((inspection) => inspection.id === id),
      'Inspection',
    );
  }
  async context(id: string) {
    const inspection = await this.get(id);
    const property = required(
      properties.find((item) => item.id === inspection.propertyId),
      'Property',
    );
    const inspectionRooms = await this.rooms(id);
    const pendingReviewCount = Object.values(useDemoStore.getState().findings).filter(
      (finding) => finding.inspectionId === id && finding.reviewStatus === 'PENDING_REVIEW',
    ).length;
    return { inspection, property, rooms: inspectionRooms, pendingReviewCount };
  }
  async report(id: string) {
    const context = await this.context(id);
    const allFindings = Object.values(useDemoStore.getState().findings).filter(
      (finding) => finding.inspectionId === id,
    );
    const snapshots = useDemoStore.getState().snapshots ?? [];
    const reportRooms = context.rooms.map((room) => {
      const roomFindings = allFindings.filter((finding) => finding.roomId === room.id);
      return {
        ...room,
        // Demo mode has no server, so local snapshots stand in for the count.
        photoCount: snapshots.filter((snapshot) => snapshot.roomId === room.id).length,
        summary:
          roomFindings.find((finding) => finding.title === 'Room condition summary')?.observation ??
          null,
        findings: roomFindings
          .filter((finding) => finding.title !== 'Room condition summary')
          .map((finding) => ({
            id: finding.id,
            findingType: 'POSSIBLE_NEW_DAMAGE' as const,
            title: finding.title,
            category: finding.category,
            severity: finding.severity,
            comparisonResult: finding.comparisonResult,
            confidence: finding.confidence,
            description: finding.observation,
            recommendedReview: finding.recommendedReview,
            reviewStatus: finding.reviewStatus,
          })),
      };
    });
    const finished = reportRooms.filter((room) =>
      ['COMPLETED', 'SKIPPED', 'RECORDING_SAVED'].includes(room.completionStatus),
    );
    return {
      inspection: context.inspection,
      property: context.property,
      generatedAt: new Date().toISOString(),
      rooms: reportRooms,
      totals: {
        rooms: reportRooms.length,
        finishedRooms: finished.length,
        summaries: reportRooms.filter((room) => room.summary).length,
        defectFindings: reportRooms.reduce((sum, room) => sum + room.findings.length, 0),
        photos: reportRooms.reduce((sum, room) => sum + room.photoCount, 0),
        pendingReviewCount: context.pendingReviewCount,
      },
    };
  }
  async start(id: string) {
    return this.get(id);
  }
  async complete(id: string) {
    return this.get(id);
  }
  async rooms(inspectionId: string) {
    await mockDelay();
    ensureMockAvailable();
    return rooms
      .filter((room) => room.inspectionId === inspectionId)
      .map(mergedRoom)
      .sort((a, b) => a.order - b.order);
  }
  async room(roomId: string) {
    await mockDelay();
    ensureMockAvailable();
    return mergedRoom(
      required(
        rooms.find((room) => room.id === roomId),
        'Room',
      ),
    );
  }
  async roomChecklist() {
    await mockDelay();
    // Mock mode has no admin-authored lists; the caller falls back to the
    // generated checklist, which is the same path a real unconfigured area takes.
    return [];
  }
  async evidenceRequests() {
    await mockDelay();
    // Demo mode has no reviewer to raise one.
    return [];
  }
  async openEvidenceRequests() {
    await mockDelay();
    // Same reason: nobody in demo mode can ask for more evidence.
    return [];
  }
  async resolveEvidenceRequest() {
    await mockDelay();
  }
  async recordChecklistItem() {
    await mockDelay();
    // Nothing to score against without authored items — see roomChecklist.
    return [];
  }
  async updateArea(roomId: string) {
    await mockDelay();
    return this.room(roomId);
  }
  async addArea(inspectionId: string, input: AddAreaInput) {
    await mockDelay();
    ensureMockAvailable();
    const siblings = rooms.filter((room) => room.inspectionId === inspectionId);
    const id = `mock-area-${siblings.length + 1}-${input.name.trim().replace(/\s+/g, '-').toLowerCase()}`;
    const room: InspectionRoom = {
      id,
      inspectionId,
      propertyAreaId: id,
      name: input.name.trim(),
      floorName: input.floorName?.trim() || 'Added areas',
      order: siblings.length + 1,
      isRequired: true,
      inspectionType: siblings[0]?.inspectionType ?? 'MOVE_OUT',
      baseline: {
        summary: 'Technician-added area.',
        condition: 'NOT_AVAILABLE',
        existingDefects: [],
        evidenceCount: 0,
      },
      completionStatus: 'NOT_STARTED',
      uploadStatus: 'PENDING',
      processingStatus: 'NOT_STARTED',
      environment: input.environment,
      category: input.category ?? null,
      source: 'TECHNICIAN',
      areaStatus: 'DRAFT',
    };
    rooms.push(room);
    return room;
  }
  async updateRoomNote(roomId: string, note: string) {
    useDemoStore.getState().updateRoom(roomId, { note });
    return this.room(roomId);
  }
  async removeRoom(roomId: string) {
    const room = await this.room(roomId);
    return { id: roomId, removed: true, name: room.name };
  }
  async skipRoom(roomId: string, reason?: string) {
    // The reason is optional now, and the refusal that used to live here went
    // with it: skipping is confirmed, not justified. See `TechnicianReasonDto`.
    useDemoStore.getState().updateRoom(roomId, {
      completionStatus: 'SKIPPED',
      skipReason: reason?.trim() || undefined,
    });
    return this.room(roomId);
  }
  async completeRoom(roomId: string) {
    const room = await this.room(roomId);
    if (room.uploadStatus !== 'COMPLETED') {
      throw new Error('Save and upload a room recording before marking this room complete.');
    }
    useDemoStore.getState().updateRoom(roomId, { completionStatus: 'COMPLETED' });
    return this.room(roomId);
  }
  async confirmRoomSummary(roomId: string) {
    // Mirrors the server's idempotency: the first confirmation's timestamp is
    // the record of when the technician actually read it, so re-confirming
    // must not move it.
    const room = await this.room(roomId);
    if (room.summaryConfirmedAt) return room;
    useDemoStore
      .getState()
      .updateRoom(roomId, { summaryConfirmedAt: new Date().toISOString() });
    return this.room(roomId);
  }
}

export class MockFloorPlanRepository implements FloorPlanRepository {
  async get() {
    return null;
  }
  async rooms(propertyId: string, inspectionId: string) {
    required(
      properties.find((property) => property.id === propertyId),
      'Property',
    );
    return new MockInspectionRepository().rooms(inspectionId);
  }
}

export class MockMediaRepository implements MediaRepository {
  async playback(mediaId: string) {
    // Demo mode has no Cloudflare account; a recording is simply not playable.
    return {
      videoId: mediaId,
      provider: 'cloudflare_stream' as const,
      status: 'processing' as const,
    };
  }

  async listForRoom(roomId: string) {
    await mockDelay();
    return useDemoStore.getState().media.filter((item) => item.roomId === roomId);
  }
  async save(input: Omit<LocalMedia, 'id' | 'recordedAt'>) {
    await mockDelay();
    const media: LocalMedia = {
      ...input,
      id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      recordedAt: new Date().toISOString(),
    };
    useDemoStore.getState().saveMedia(media);
    return media;
  }
  async photosForRoom(roomId: string) {
    await mockDelay();
    // Demo mode has no server, so local snapshots stand in for server photos.
    return (useDemoStore.getState().snapshots ?? [])
      .filter((snapshot) => snapshot.roomId === roomId)
      .map((snapshot) => ({
        id: snapshot.id,
        roomId: snapshot.roomId,
        findingId: null,
        captureType: snapshot.captureType ?? ('AREA_OVERVIEW' as const),
        sequenceNumber: snapshot.sequenceNumber ?? null,
        label: null,
        capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
        contentPath: snapshot.uri,
      }));
  }
}

export class MockUploadRepository implements UploadRepository {
  async list() {
    await mockDelay();
    return useDemoStore.getState().uploads;
  }
  async enqueue(media: LocalMedia) {
    const room = required(
      rooms.find((candidate) => candidate.id === media.roomId),
      'Room',
    );
    const inspection = required(
      inspections.find((candidate) => candidate.id === media.inspectionId),
      'Inspection',
    );
    const property = required(
      properties.find((candidate) => candidate.id === inspection.propertyId),
      'Property',
    );
    const item = {
      id: `upload-${media.id}`,
      mediaId: media.id,
      inspectionId: media.inspectionId,
      roomId: media.roomId,
      recordingType: media.recordingType ?? ('PRIMARY_AREA' as const),
      label: media.label,
      category: media.category,
      relatedFindingId: media.relatedFindingId,
      propertyAddress: media.propertyAddress ?? property.address,
      roomName: media.roomName ?? room.name,
      durationSeconds: media.durationSeconds,
      estimatedSizeMb: media.estimatedSizeMb,
      status: 'PENDING' as const,
      progress: 0,
      processingStatus: 'NOT_STARTED' as const,
      processingProgress: 0,
      createdAt: new Date().toISOString(),
      operationId: `upload:${media.id}`,
      __sync: { state: 'OFFLINE_PENDING' as const, operationId: `upload:${media.id}` },
    };
    useDemoStore.getState().enqueueUpload(item);
    return item;
  }
  async pause(id: string) {
    useDemoStore.getState().updateUpload(id, { status: 'PAUSED' });
  }
  async resume(id: string) {
    useDemoStore.getState().updateUpload(id, { status: 'PENDING', lastError: undefined });
  }
  async retry(id: string) {
    useDemoStore.getState().updateUpload(id, {
      status: 'PENDING',
      progress: 0,
      lastError: undefined,
    });
  }
  async retryProcessing(id: string) {
    useDemoStore.getState().updateUpload(id, {
      processingStatus: 'VIDEO_PROCESSING',
      processingProgress: 0,
    });
  }
  async remove(id: string) {
    useDemoStore.getState().removeUpload(id);
  }
  async tick() {
    useDemoStore.getState().tickUploads();
    return true;
  }
}

export class MockFindingRepository implements FindingRepository {
  async list(inspectionId?: string, kind: FindingKind = 'DEFECTS') {
    await mockDelay();
    ensureMockAvailable();
    const findings = Object.values(useDemoStore.getState().findings);
    const scoped = inspectionId
      ? findings.filter((item) => item.inspectionId === inspectionId)
      : findings;
    // Mirrors the server's `kind` filter so demo mode cannot drift from the
    // real API and hide a mixed-in summary bug.
    if (kind === 'SUMMARIES') return scoped.filter(isRoomSummary);
    if (kind === 'DEFECTS') return scoped.filter((item) => !isRoomSummary(item));
    return scoped;
  }
  async get(id: string) {
    await mockDelay();
    return required(useDemoStore.getState().findings[id], 'Finding');
  }
  private update(id: string, update: Partial<Finding>) {
    useDemoStore.getState().updateFinding(id, update);
    return this.get(id);
  }
  async approve(id: string) {
    return this.update(id, { reviewStatus: 'APPROVED' });
  }
  async edit(id: string, observation: string, notes: string) {
    if (!observation.trim()) throw new Error('The observation cannot be empty.');
    return this.update(id, {
      observation: observation.trim(),
      reviewerNotes: notes.trim(),
      reviewStatus: 'EDITED',
    });
  }
  async reject(id: string, reason: string) {
    if (!reason.trim()) throw new Error('A reason is required to reject a finding.');
    return this.update(id, { reviewStatus: 'REJECTED', reviewerNotes: reason.trim() });
  }
  async requestReinspection(id: string, reason: string) {
    if (!reason.trim()) throw new Error('A reason is required to request reinspection.');
    return this.update(id, {
      reviewStatus: 'REINSPECTION_REQUESTED',
      reviewerNotes: reason.trim(),
    });
  }
}
