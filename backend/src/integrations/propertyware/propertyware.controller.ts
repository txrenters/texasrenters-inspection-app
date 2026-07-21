/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@texasrenters/shared';

import { ApiAuthGuard, Roles, RolesGuard, type AuthenticatedRequest } from '../../common/auth';
import { ApplicationError } from '../../common/errors';
import { CacheService } from '../../cache/cache.service';
import {
  CatalogQueryDto,
  PropertywareSyncRequestDto,
  PropertywareSyncErrorQueryDto,
  PropertywareSyncRunQueryDto,
} from './propertyware.dto';
import {
  PROPERTYWARE_SYNC_STORE,
  type PropertywareSyncStore,
} from '../../workers/propertyware-sync/propertyware-sync.store';
import { PropertywareSyncCoordinator } from '../../workers/propertyware-sync/propertyware-sync.coordinator';

@ApiTags('Propertyware integration')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Controller(['integrations/propertyware', 'admin/integrations/propertyware'])
export class PropertywareIntegrationController {
  private readonly requests = new Map<string, number[]>();
  constructor(
    @Inject(PropertywareSyncCoordinator) private readonly coordinator: PropertywareSyncCoordinator,
    @Inject(PROPERTYWARE_SYNC_STORE) private readonly store: PropertywareSyncStore,
    @Optional() @Inject(CacheService) private readonly cache?: CacheService,
  ) {}

  @Post('sync')
  @HttpCode(202)
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  sync(@Req() request: AuthenticatedRequest, @Body() body: PropertywareSyncRequestDto) {
    this.assertRateLimit(request.user.id);
    return this.coordinator.enqueue({
      organizationId: request.user.organizationId,
      requestedBy: request.user.id,
      entities: body.entities,
      mode: body.mode,
    });
  }

  @Post('sync/initial')
  @HttpCode(202)
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  initial(@Req() request: AuthenticatedRequest, @Body() body: PropertywareSyncRequestDto) {
    this.assertRateLimit(request.user.id);
    return this.coordinator.enqueue({
      organizationId: request.user.organizationId,
      requestedBy: request.user.id,
      entities: body.entities,
      mode: 'initial',
    });
  }

  @Post('sync/incremental')
  @HttpCode(202)
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  incremental(@Req() request: AuthenticatedRequest, @Body() body: PropertywareSyncRequestDto) {
    this.assertRateLimit(request.user.id);
    return this.coordinator.enqueue({
      organizationId: request.user.organizationId,
      requestedBy: request.user.id,
      entities: body.entities,
      mode: 'incremental',
    });
  }

  @Post('reconcile')
  @HttpCode(202)
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  reconcile(@Req() request: AuthenticatedRequest, @Body() body: PropertywareSyncRequestDto) {
    this.assertRateLimit(request.user.id);
    return this.coordinator.enqueue({
      organizationId: request.user.organizationId,
      requestedBy: request.user.id,
      entities: body.entities,
      mode: 'reconciliation',
    });
  }

  @Get('sync-runs')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  runs(@Req() request: AuthenticatedRequest, @Query() query: PropertywareSyncRunQueryDto) {
    return this.store.listRunsPage(request.user.organizationId, query);
  }

  @Get('sync-runs/:syncRunId')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  async run(@Req() request: AuthenticatedRequest, @Param('syncRunId') id: string) {
    const run = (await this.store.getRun(id)) as { organizationId?: string } | null;
    if (!run || run.organizationId !== request.user.organizationId)
      throw new ApplicationError(404, 'SYNC_RUN_NOT_FOUND', 'Sync run was not found.');
    const response: Record<string, unknown> = { ...run };
    delete response.organizationId;
    return response;
  }

  @Get('sync-runs/:syncRunId/errors')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  errors(
    @Req() request: AuthenticatedRequest,
    @Param('syncRunId') id: string,
    @Query() query: PropertywareSyncErrorQueryDto,
  ) {
    return this.store.listErrorsPage(request.user.organizationId, id, query);
  }

  @Get('status')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.PROPERTY_ADMIN)
  status(@Req() request: AuthenticatedRequest) {
    return this.cache
      ? this.cache.getOrLoad({
          resource: 'propertywareStatus',
          scope: request.user.organizationId,
          query: { view: 'integration-status' },
          loader: () => this.store.status(request.user.organizationId),
        })
      : this.store.status(request.user.organizationId);
  }

  private assertRateLimit(userId: string) {
    const now = Date.now();
    const recent = (this.requests.get(userId) ?? []).filter((time) => time > now - 60_000);
    if (recent.length >= 5)
      throw new ApplicationError(
        429,
        'PROPERTYWARE_SYNC_RATE_LIMIT',
        'Try the manual sync again later.',
      );
    recent.push(now);
    this.requests.set(userId, recent);
  }
}

@ApiTags('Property catalog')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, RolesGuard)
@Controller()
export class PropertywareCatalogController {
  constructor(@Inject(PROPERTYWARE_SYNC_STORE) private readonly store: PropertywareSyncStore) {}

  @Get('portfolios') portfolios(
    @Req() request: AuthenticatedRequest,
    @Query() query: CatalogQueryDto,
  ) {
    return this.store.listActivePage('portfolios', request.user.organizationId, query);
  }
  @Get('portfolios/:portfolioId') portfolio(
    @Req() request: AuthenticatedRequest,
    @Param('portfolioId') id: string,
  ) {
    return this.store.getActive('portfolios', request.user.organizationId, id);
  }
  @Get('properties') properties(
    @Req() request: AuthenticatedRequest,
    @Query() query: CatalogQueryDto,
  ) {
    return this.store.listActivePage('buildings', request.user.organizationId, query);
  }
  @Get('properties/:propertyId') property(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
  ) {
    return this.store.getActive('buildings', request.user.organizationId, id);
  }
  @Get('properties/:propertyId/units') units(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId') id: string,
    @Query() query: CatalogQueryDto,
  ) {
    return this.store.listActivePage('units', request.user.organizationId, {
      ...query,
      propertyId: id,
    });
  }
  @Get('units/:unitId') unit(@Req() request: AuthenticatedRequest, @Param('unitId') id: string) {
    return this.store.getActive('units', request.user.organizationId, id);
  }
  @Get('units/:unitId/leases') leases(
    @Req() request: AuthenticatedRequest,
    @Param('unitId') id: string,
    @Query() query: CatalogQueryDto,
  ) {
    return this.store.listActivePage('leases', request.user.organizationId, {
      ...query,
      unitId: id,
    });
  }
  @Get('leases/:leaseId') lease(
    @Req() request: AuthenticatedRequest,
    @Param('leaseId') id: string,
  ) {
    return this.store.getActive('leases', request.user.organizationId, id);
  }
}
