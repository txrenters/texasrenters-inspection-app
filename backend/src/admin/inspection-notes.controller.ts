import {
  Body,
  Controller,
  Delete,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InspectionNotesService } from './inspection-notes.service';

export class OfficeNoteDto {
  // Room for the spaces the service trims off; it holds the note to the limit.
  @IsString() @MaxLength(4000) text!: string;
  @IsBoolean() visibleToTechnician!: boolean;
}

/**
 * The office's notes on a job. Reading them comes with the job. Writing takes
 * either of two grants, which the service checks, as the guard requires all the
 * permissions it is given.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/inspections/:inspectionId/notes')
export class InspectionNotesController {
  constructor(@Inject(InspectionNotesService) private readonly service: InspectionNotesService) {}

  @Post()
  @RequirePermissions('inspections:read')
  add(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Body() body: OfficeNoteDto,
  ) {
    return this.service.add(request.user, inspectionId, body);
  }

  @Patch(':noteId')
  @RequirePermissions('inspections:read')
  edit(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string,
    @Body() body: OfficeNoteDto,
  ) {
    return this.service.edit(request.user, inspectionId, noteId, body);
  }

  @Delete(':noteId')
  @RequirePermissions('inspections:read')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('inspectionId', new ParseUUIDPipe()) inspectionId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string,
  ) {
    return this.service.remove(request.user, inspectionId, noteId);
  }
}
