import type {
  AuthRepository,
  FindingRepository,
  FloorPlanRepository,
  InspectionRepository,
  MediaRepository,
  PropertyRepository,
  UploadRepository,
} from '../contracts';
import type { DemoRole, DemoUser, Finding, InspectionRoom, LocalMedia } from '../../domain/models';
import { useDemoStore } from '../../stores/demo.store';
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
  async list(filters: { status?: string; search?: string } = {}) {
    await mockDelay();
    ensureMockAvailable();
    return inspections.filter(
      (inspection) =>
        (!filters.status || inspection.status === filters.status) &&
        (!filters.search ||
          inspection.property.address.toLowerCase().includes(filters.search.toLowerCase())),
    );
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
  async updateRoomNote(roomId: string, note: string) {
    useDemoStore.getState().updateRoom(roomId, { note });
    return this.room(roomId);
  }
  async skipRoom(roomId: string, reason: string) {
    if (!reason.trim()) throw new Error('A reason is required to skip this room.');
    useDemoStore.getState().updateRoom(roomId, {
      completionStatus: 'SKIPPED',
      skipReason: reason.trim(),
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
      propertyAddress: media.propertyAddress ?? property.address,
      roomName: media.roomName ?? room.name,
      durationSeconds: media.durationSeconds,
      estimatedSizeMb: media.estimatedSizeMb,
      status: 'PENDING' as const,
      progress: 0,
      processingStatus: 'NOT_STARTED' as const,
      processingProgress: 0,
      createdAt: new Date().toISOString(),
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
  }
}

export class MockFindingRepository implements FindingRepository {
  async list(inspectionId?: string) {
    await mockDelay();
    ensureMockAvailable();
    const findings = Object.values(useDemoStore.getState().findings);
    return inspectionId ? findings.filter((item) => item.inspectionId === inspectionId) : findings;
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
