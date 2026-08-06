import type { VideoPlaybackResponse } from '../media/playback-source';
import type {
  AreaEnvironment,
  DashboardSummary,
  DemoRole,
  DemoUser,
  Finding,
  FloorPlanDocument,
  Inspection,
  InspectionContext,
  InspectionReport,
  InspectionStatus,
  InspectionRoom,
  LocalMedia,
  LeaseSummary,
  PortfolioSummary,
  Property,
  RoomPhoto,
  UnitSummary,
  UploadItem,
} from '../domain/models';

export interface AddAreaInput {
  name: string;
  environment: AreaEnvironment;
  category?: string;
  floorName?: string;
  notes?: string;
}

export interface AuthRepository {
  listDemoUsers(): Promise<DemoUser[]>;
  signIn(role: DemoRole): Promise<DemoUser>;
  signInWithPassword(email: string, password: string): Promise<DemoUser>;
  changeRequiredPassword(password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  currentUser(): Promise<DemoUser | null>;
  signOut(): Promise<void>;
}

export interface PropertyRepository {
  list(): Promise<Property[]>;
  get(id: string): Promise<Property>;
}

export interface CatalogRepository {
  portfolios(): Promise<PortfolioSummary[]>;
  properties(portfolioId?: string): Promise<Property[]>;
  units(propertyId: string): Promise<UnitSummary[]>;
  leases(unitId: string): Promise<LeaseSummary[]>;
}

export interface InspectionRepository {
  dashboard(): Promise<DashboardSummary>;
  list(filters?: { status?: InspectionStatus; search?: string }): Promise<Inspection[]>;
  get(id: string): Promise<Inspection>;
  context(id: string): Promise<InspectionContext>;
  report(id: string): Promise<InspectionReport>;
  start(id: string): Promise<Inspection>;
  complete(id: string): Promise<Inspection>;
  rooms(inspectionId: string): Promise<InspectionRoom[]>;
  room(roomId: string): Promise<InspectionRoom>;
  addArea(inspectionId: string, input: AddAreaInput): Promise<InspectionRoom>;
  /** Administrator-authored coverage checklist; empty when none is configured. */
  roomChecklist(roomId: string): Promise<{ id: string; label: string; keywords: string[] }[]>;
  updateRoomNote(roomId: string, note: string): Promise<InspectionRoom>;
  skipRoom(roomId: string, reason: string): Promise<InspectionRoom>;
  completeRoom(roomId: string): Promise<InspectionRoom>;
}

export interface FloorPlanRepository {
  get(propertyId: string): Promise<FloorPlanDocument | null>;
  rooms(propertyId: string, inspectionId: string): Promise<InspectionRoom[]>;
}

export interface MediaRepository {
  listForRoom(roomId: string): Promise<LocalMedia[]>;
  /**
   * Where and how to play one uploaded recording.
   *
   * Returns a signed edge URL rather than bytes: the backend never proxies the
   * video, and the token is short-lived so it is fetched when a technician
   * opens the recording rather than held.
   */
  playback(mediaId: string): Promise<VideoPlaybackResponse>;
  save(input: Omit<LocalMedia, 'id' | 'recordedAt'>): Promise<LocalMedia>;
  /**
   * Photos the server holds for this area.
   *
   * Distinct from the device's local snapshot store, which only knows about
   * captures made on this handset. A technician who reinstalled, switched
   * phones, or cleared the local cache still has their evidence — counting the
   * local store would tell them it was gone.
   */
  photosForRoom(roomId: string): Promise<RoomPhoto[]>;
}

export interface UploadRepository {
  list(): Promise<UploadItem[]>;
  enqueue(media: LocalMedia): Promise<UploadItem>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  retryProcessing(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  tick(): Promise<boolean>;
}

/**
 * The API stores the per-room AI summary as a finding row of its own
 * (`findingType: NO_CHANGE`, title "Room condition summary"), so an unfiltered
 * list mixes narrative summaries in with actual defects. Always ask for one.
 */
export type FindingKind = 'ALL' | 'DEFECTS' | 'SUMMARIES';

export interface FindingRepository {
  list(inspectionId?: string, kind?: FindingKind): Promise<Finding[]>;
  get(id: string, inspectionId?: string): Promise<Finding>;
  approve(id: string): Promise<Finding>;
  edit(id: string, observation: string, notes: string): Promise<Finding>;
  reject(id: string, reason: string): Promise<Finding>;
  requestReinspection(id: string, reason: string): Promise<Finding>;
}

export interface Repositories {
  auth: AuthRepository;
  properties: PropertyRepository;
  catalog: CatalogRepository;
  inspections: InspectionRepository;
  floorPlans: FloorPlanRepository;
  media: MediaRepository;
  uploads: UploadRepository;
  findings: FindingRepository;
}
