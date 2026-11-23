/* DTO classes and guards are runtime imports required by Nest metadata. */
import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

import {
  ApiAuthGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedRequest,
} from '../common/auth';
import { TechnicianScopeSheetService } from './technician-scope-sheet';
import { autoAssignLive, WorkOrderTriageService } from './work-order-triage.service';

export class ImportScopeSheetDto {
  /** False, or left out, only says what an import would do. */
  @IsOptional() @IsBoolean() apply?: boolean;
}

/**
 * Matching work orders to technicians by skill, from the console's Work
 * orders page: whether it is live or a trial, loading the office's Scope of
 * Work sheet, and matching the work orders already waiting.
 *
 * Behind `technicians:skills`, the grant that decides who is qualified for
 * what -- these decide the same thing.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/work-order-matching')
export class WorkOrderMatchingController {
  constructor(
    @Inject(TechnicianScopeSheetService) private readonly sheet: TechnicianScopeSheetService,
    @Inject(WorkOrderTriageService) private readonly triage: WorkOrderTriageService,
  ) {}

  @Get()
  @RequirePermissions('technicians:skills')
  status() {
    return { live: autoAssignLive() };
  }

  @Post('import-skills')
  @HttpCode(200)
  @RequirePermissions('technicians:skills')
  importSkills(@Req() request: AuthenticatedRequest, @Body() body: ImportScopeSheetDto) {
    return this.sheet.import(request.user, body.apply === true);
  }

  @Post('check-open')
  @HttpCode(200)
  @RequirePermissions('technicians:skills')
  checkOpen(@Req() request: AuthenticatedRequest) {
    return this.triage.matchOpen(request.user);
  }
}
