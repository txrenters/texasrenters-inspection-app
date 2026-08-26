/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import {
  ApiClientListQueryDto,
  CreateApiClientDto,
  CreateApiClientKeyDto,
  UpdateApiClientDto,
} from './api-client.dto';
import { ApiClientService } from './api-client.service';

/**
 * Registration and key lifecycle for third-party integrations.
 *
 * Bearer-authenticated and `system:manage` throughout, and deliberately **not**
 * marked machine-accessible anywhere: issuing credentials is the one thing a
 * credential must never be able to do. A key that could mint keys would make
 * revocation meaningless.
 */
@ApiTags('IT tools')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/api-clients')
export class ApiClientController {
  constructor(@Inject(ApiClientService) private readonly clients: ApiClientService) {}

  /** Registered integrations, with the keys each one holds. */
  @Get()
  @RequirePermissions('system:manage')
  list(@Req() request: AuthenticatedRequest, @Query() query: ApiClientListQueryDto) {
    return this.clients.list(request.user, query);
  }

  @Get(':clientId')
  @RequirePermissions('system:manage')
  get(@Req() request: AuthenticatedRequest, @Param('clientId') clientId: string) {
    return this.clients.get(request.user, clientId);
  }

  /** Register an integration. Creating it issues no credential — keys are separate. */
  @Post()
  @RequirePermissions('system:manage')
  create(@Req() request: AuthenticatedRequest, @Body() body: CreateApiClientDto) {
    return this.clients.create(request.user, body);
  }

  @Patch(':clientId')
  @RequirePermissions('system:manage')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('clientId') clientId: string,
    @Body() body: UpdateApiClientDto,
  ) {
    return this.clients.update(request.user, clientId, body);
  }

  /** Revoke the client and every key it holds. Not a delete: the audit trail references it. */
  @Delete(':clientId')
  @RequirePermissions('system:manage')
  revoke(@Req() request: AuthenticatedRequest, @Param('clientId') clientId: string) {
    return this.clients.revoke(request.user, clientId);
  }

  /**
   * Issue a key. The response carries the secret, once — it is not stored and
   * cannot be read again.
   */
  @Post(':clientId/keys')
  @RequirePermissions('system:manage')
  createKey(
    @Req() request: AuthenticatedRequest,
    @Param('clientId') clientId: string,
    @Body() body: CreateApiClientKeyDto,
  ) {
    return this.clients.createKey(request.user, clientId, body);
  }

  /** Revoke one key, leaving the client and its other keys working. */
  @Delete(':clientId/keys/:keyId')
  @RequirePermissions('system:manage')
  revokeKey(
    @Req() request: AuthenticatedRequest,
    @Param('clientId') clientId: string,
    @Param('keyId') keyId: string,
  ) {
    return this.clients.revokeKey(request.user, clientId, keyId);
  }
}
