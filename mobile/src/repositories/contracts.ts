import type { VideoPlaybackResponse } from '../media/playback-source';
import type {
  AreaEnvironment,
  ChecklistAssessment,
  ChecklistItemWithAssessment,
  EvidenceRequest,
  OpenEvidenceRequest,
  DashboardSummary,
  DemoRole,
  DemoUser,
  Finding,
  FloorPlanDocument,
  Inspection,
  InspectionContext,
  InspectionReport,
  InspectionRoom,
  InspectionStatus,
  LeaseSummary,
  LocalMedia,
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

/**
 * Corrections to an area the technician added. Every field optional: this is a
 * correction, so sending only the name must not blank the rest.
 */
export interface UpdateAreaInput {
  name?: string;
  environment?: AreaEnvironment;
  category?: string | null;
  notes?: string;
}

export interface AuthRepository {
  listDemoUsers(): Promise<DemoUser[]>;
  signIn(role: DemoRole): Promise<DemoUser>;
  /**
   * `takeOver` ends the session on the technician's other device.
   *
   * Optional so the first attempt cannot carry it: a technician is refused
   * with SESSION_ALREADY_ACTIVE and only then offered this, so signing another
   * handset out is always something that was asked for.
   */
  signInWithPassword(email: string, password: string, takeOver?: boolean): Promise<DemoUser>;
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

/**
 * How many inspections one page asks for.
 *
 * Lives with the contract rather than the API client so the demo repository can
 * share it without importing expo-file-system and a session along with it.
 *
 * The list pages rather than truncating now, so this is a batch size and not a
 * ceiling. It was effectively a ceiling before: `pageSize=25` with the server
 * ordering `scheduledAt: 'asc'` meant the twenty-five *oldest* records filled
 * the only page, and newly scheduled work never arrived at all.
 */
export const INSPECTION_PAGE_SIZE = 25;

/**
 * What the technician list endpoint filters by.
 *
 * `statuses` is plural because the screen's chips are groups: "Submitted"
 * covers every post-handover status. Sending the set means the server filters
 * and paginates, instead of the device slicing whatever arrived first.
 */
export interface InspectionListFilters {
  statuses?: readonly InspectionStatus[];
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * One page, with the server's `total` carried through.
 *
 * The total used to be dropped on the floor by a `z.object({ items })` schema,
 * so the list header could only ever count the rows it happened to be holding
 * and read "25 total" for a technician with hundreds of inspections.
 */
export interface InspectionPage {
  items: Inspection[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * The technician's day, ordered from where they are now.
 *
 * A suggestion. Nothing records whether it was followed, and it is recomputed
 * from wherever they actually are, so taking a different stop first simply
 * produces a different suggestion rather than putting anybody off-plan.
 */
export interface DayRouteStop {
  inspectionId: string;
  propertyId: string;
  propertyName: string;
  addressLine1: string;
  city: string;
  latitude: number;
  longitude: number;
}

export interface DayRouteLeg {
  fromStopId: string | null;
  toStopId: string;
  distanceMeters: number;
  durationSeconds: number;
}

export interface TechnicianDayRoute {
  technicianId: string;
  origin: { latitude: number; longitude: number; recordedAt: string } | null;
  stops: DayRouteStop[];
  legs: DayRouteLeg[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  /** Carried, not dropped: the inspection is still theirs, the address is not on a map. */
  unroutable: { inspectionId: string; propertyName: string }[];
}

export interface InspectionRepository {
  /** Ordered stops for today. Never served from cache — see the API repository. */
  route(): Promise<TechnicianDayRoute>;
  dashboard(): Promise<DashboardSummary>;
  listPage(filters?: InspectionListFilters): Promise<InspectionPage>;
  list(filters?: InspectionListFilters): Promise<Inspection[]>;
  get(id: string): Promise<Inspection>;
  context(id: string): Promise<InspectionContext>;
  report(id: string): Promise<InspectionReport>;
  start(id: string): Promise<Inspection>;
  complete(id: string): Promise<Inspection>;
  rooms(inspectionId: string): Promise<InspectionRoom[]>;
  room(roomId: string): Promise<InspectionRoom>;
  addArea(inspectionId: string, input: AddAreaInput): Promise<InspectionRoom>;
  /** Corrects an area this technician added; the server refuses the rest. */
  updateArea(roomId: string, input: UpdateAreaInput): Promise<InspectionRoom>;
  /** Administrator-authored coverage checklist; empty when none is configured. */
  roomChecklist(roomId: string): Promise<ChecklistItemWithAssessment[]>;
  /**
   * Records how one checklist item was found. The payload is the item's
   * complete assessment — an omitted axis is stored as unassessed, matching
   * the route's replace semantics.
   */
  recordChecklistItem(
    roomId: string,
    itemId: string,
    assessment: ChecklistAssessment,
  ): Promise<ChecklistItemWithAssessment[]>;
  /** Open requests from the office for more evidence on this inspection. */
  evidenceRequests(inspectionId: string): Promise<EvidenceRequest[]>;
  openEvidenceRequests(): Promise<OpenEvidenceRequest[]>;
  /** The technician's own call that a request is satisfied. */
  resolveEvidenceRequest(requestId: string): Promise<void>;
  updateRoomNote(roomId: string, note: string): Promise<InspectionRoom>;
  skipRoom(roomId: string, reason?: string): Promise<InspectionRoom>;
  /**
   * Takes a room off the inspection entirely — one the property does not have.
   *
   * Returns nothing to merge: the room is gone, so the caller invalidates
   * rather than patching an entity that no longer exists.
   */
  removeRoom(roomId: string): Promise<{ id: string; removed: boolean; name: string }>;
  completeRoom(roomId: string): Promise<InspectionRoom>;
  /**
   * Records that the technician read the AI summary for an area and it matches
   * what they saw. Not finding review — approving or rejecting a finding is an
   * administrator action with no technician-side counterpart.
   */
  confirmRoomSummary(roomId: string): Promise<InspectionRoom>;
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
