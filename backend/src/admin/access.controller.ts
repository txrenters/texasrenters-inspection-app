/* DTO classes and guards are runtime imports required by Nest metadata. */
/* eslint-disable @typescript-eslint/consistent-type-imports */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import {
  AccessListQueryDto,
  CreateRoleDto,
  CreateUserDto,
  SetUserRolesDto,
  UpdateRoleDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './access.dto';
import { AccessService } from './access.service';
import { ProfileDeletionService } from './profile-deletion.service';
import { TechnicianProvisioningService } from './technician-provisioning.service';

/**
 * User management and fully-customizable RBAC. Every route is permission-gated
 * so a user granted `users:manage` / `roles:manage` through a custom role can
 * administer access without receiving an unrelated preset access level.
 */
@ApiTags('Access management')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/access')
export class AccessController {
  constructor(
    @Inject(AccessService) private readonly service: AccessService,
    @Inject(ProfileDeletionService) private readonly deletion: ProfileDeletionService,
    @Inject(TechnicianProvisioningService)
    private readonly technicians: TechnicianProvisioningService,
  ) {}

  @Get('permissions')
  @RequirePermissions('roles:read')
  permissions() {
    return this.service.permissionCatalog();
  }

  @Get('roles')
  @RequirePermissions('roles:read')
  roles(@Req() request: AuthenticatedRequest, @Query() query: AccessListQueryDto) {
    return this.service.listRoles(request.user, query);
  }

  @Post('roles')
  @RequirePermissions('roles:manage')
  createRole(@Req() request: AuthenticatedRequest, @Body() body: CreateRoleDto) {
    return this.service.createRole(request.user, body);
  }

  @Get('roles/:id')
  @RequirePermissions('roles:read')
  role(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.role(request.user, id);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles:manage')
  updateRole(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateRoleDto,
  ) {
    return this.service.updateRole(request.user, id, body);
  }

  @Delete('roles/:id')
  @RequirePermissions('roles:manage')
  deleteRole(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.deleteRole(request.user, id);
  }

  @Get('users')
  @RequirePermissions('users:read')
  users(@Req() request: AuthenticatedRequest, @Query() query: AccessListQueryDto) {
    return this.service.listUsers(request.user, query);
  }

  @Post('users')
  @RequirePermissions('users:manage')
  createUser(@Req() request: AuthenticatedRequest, @Body() body: CreateUserDto) {
    return this.service.createUser(request.user, body);
  }

  @Get('users/:id')
  @RequirePermissions('users:read')
  user(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.service.user(request.user, id);
  }

  @Patch('users/:id')
  @RequirePermissions('users:manage')
  updateUser(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.service.updateUser(request.user, id, body.displayName);
  }

  @Patch('users/:id/status')
  @RequirePermissions('users:manage')
  updateUserStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.service.updateUserStatus(request.user, id, body.isActive);
  }

  @Put('users/:id/roles')
  @RequirePermissions('users:manage')
  setUserRoles(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SetUserRolesDto,
  ) {
    return this.service.setUserRoles(request.user, id, body);
  }

  /**
   * Let this console user onto the handset as well.
   *
   * Behind `technicians:provision` rather than `users:manage`, for the mirror
   * of the reason the console grant is behind `users:manage`: the button lives
   * on the user page, but the act is provisioning a technician, and the
   * permission has to follow the act rather than the screen.
   *
   * Adds the membership only. The account already has a password, and issuing a
   * temporary one here would lock them out of the console they are using.
   */
  @Post('users/:id/technician-access')
  @RequirePermissions('technicians:provision')
  grantTechnicianAccess(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.technicians.grantTechnicianAccess(request.user, id);
  }

  /**
   * What deleting this user would cost, so the confirmation can state it.
   * Read-only, and gated on `users:manage` rather than `users:read` because it
   * exists only to serve a destructive action.
   */
  @Get('users/:id/deletion-preflight')
  @RequirePermissions('users:manage')
  userDeletionPreflight(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.deletion.preflight(request.user, id, 'CONSOLE');
  }

  @Delete('users/:id')
  @RequirePermissions('users:manage')
  deleteUser(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.deletion.remove(request.user, id, 'CONSOLE');
  }
}
