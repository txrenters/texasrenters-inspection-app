import { environment } from '../config/environment';
import type { Repositories } from './contracts';
import {
  ApiAuthRepository,
  ApiCatalogRepository,
  ApiFindingRepository,
  ApiFloorPlanRepository,
  ApiHomeRepository,
  ApiInspectionRepository,
  ApiMediaRepository,
  ApiPropertyRepository,
  ApiUploadRepository,
} from './api/repositories';
import { ApiStockRepository } from './api/job-stock';
import { ApiCountRepository } from './api/truck-counts';
import {
  MockAuthRepository,
  MockFindingRepository,
  MockFloorPlanRepository,
  MockHomeRepository,
  MockCountRepository,
  MockStockRepository,
  MockInspectionRepository,
  MockMediaRepository,
  MockPropertyRepository,
  MockUploadRepository,
} from './mock/repositories';

const mockPropertyRepository = new MockPropertyRepository();
const mockCatalog: Repositories['catalog'] = {
  portfolios: async () => [],
  properties: () => mockPropertyRepository.list(),
  units: async () => [],
  leases: async () => [],
};

const mockRepositories: Repositories = {
  auth: new MockAuthRepository(),
  properties: mockPropertyRepository,
  catalog: mockCatalog,
  inspections: new MockInspectionRepository(),
  floorPlans: new MockFloorPlanRepository(),
  media: new MockMediaRepository(),
  uploads: new MockUploadRepository(),
  findings: new MockFindingRepository(),
  home: new MockHomeRepository(),
  stock: new MockStockRepository(),
  counts: new MockCountRepository(),
};

const apiRepositories: Repositories = {
  auth: new ApiAuthRepository(),
  properties: new ApiPropertyRepository(),
  catalog: new ApiCatalogRepository(),
  inspections: new ApiInspectionRepository(),
  floorPlans: new ApiFloorPlanRepository(),
  media: new ApiMediaRepository(),
  uploads: new ApiUploadRepository(),
  findings: new ApiFindingRepository(),
  home: new ApiHomeRepository(),
  stock: new ApiStockRepository(),
  counts: new ApiCountRepository(),
};

export const repositories = environment.dataSource === 'api' ? apiRepositories : mockRepositories;
export type { Repositories } from './contracts';
