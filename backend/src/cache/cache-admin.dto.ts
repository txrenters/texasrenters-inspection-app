import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import type { CacheResource } from './cache-policy';

export const CACHE_RESOURCES: CacheResource[] = [
  'dashboard',
  'portfolios',
  'properties',
  'propertySearch',
  'propertyDetails',
  'units',
  'leases',
  'technicians',
  'providerReadiness',
  'propertywareStatus',
];

export class CacheInvalidateDto {
  @IsIn(CACHE_RESOURCES) resource!: CacheResource;
  @IsOptional() @IsString() @MaxLength(200) id?: string;
  @IsOptional() @IsObject() query?: Record<string, unknown>;
}

export class CacheNamespaceDto {
  @IsIn(CACHE_RESOURCES) namespace!: CacheResource;
}
