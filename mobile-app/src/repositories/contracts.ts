import type {
  DashboardSummary,
  DemoRole,
  DemoUser,
  Finding,
  FloorPlanDocument,
  Inspection,
  InspectionContext,
  InspectionStatus,
  InspectionRoom,
  LocalMedia,
  LeaseSummary,
  PortfolioSummary,
  Property,
  UnitSummary,
  UploadItem,
} from '../domain/models';

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
  start(id: string): Promise<Inspection>;
  complete(id: string): Promise<Inspection>;
  rooms(inspectionId: string): Promise<InspectionRoom[]>;
  room(roomId: string): Promise<InspectionRoom>;
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
  save(input: Omit<LocalMedia, 'id' | 'recordedAt'>): Promise<LocalMedia>;
}

export interface UploadRepository {
  list(): Promise<UploadItem[]>;
  enqueue(media: LocalMedia): Promise<UploadItem>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  retryProcessing(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  tick(): Promise<void>;
}

export interface FindingRepository {
  list(inspectionId?: string): Promise<Finding[]>;
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
