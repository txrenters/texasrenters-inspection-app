import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  MOST_REQUISITION_LINES,
  MOST_REQUISITION_QUOTES,
  MOST_STOCK_QUANTITY,
  MOST_UNIT_COST_CENTS,
  REQUISITION_FILE_MAX_BYTES,
  REQUISITION_LINK_MAX_LENGTH,
  REQUISITION_LINK_TITLE_MAX_LENGTH,
  REQUISITION_NOTE_MAX_LENGTH,
  type AddRequisitionLinkInput,
  type AddRequisitionNoteInput,
  type RequisitionDecisionInput,
  type RequisitionLineInput,
  type RequisitionQuoteInput,
  type SavePurchasingSettingsInput,
  type SaveRequisitionInput,
  type SetRequisitionFileInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchasingService } from './purchasing.service';
import { RequisitionFilesService, type UploadedRequisitionFile } from './requisition-files.service';
import { RequisitionNotesService } from './requisition-notes.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Null is "none"; anything else is checked. The form sends the whole requisition, so every field is there. */
const GIVEN = (_: object, value: unknown) => value !== null;
/** A quote or a limit past this is a typo: $1,000,000.00. */
const MOST_CENTS = 100_000_000;

export class RequisitionLineDto implements Required<RequisitionLineInput> {
  @IsUUID() itemId!: string;
  @IsInt() @Min(1) @Max(MOST_STOCK_QUANTITY) quantity!: number;
  @IsInt() @Min(0) @Max(MOST_UNIT_COST_CENTS) estimatedUnitCostCents!: number;
  // 2026-11-20: optional, so a caller that sends only the three above is read as before. Null or left out is "none".
  @IsOptional() @IsString() @MaxLength(200) description!: string | null;
  @IsOptional() @IsUUID() placeId!: string | null;
  @IsOptional() @Matches(DAY) expectedOn!: string | null;
  @IsOptional() @IsUUID() vendorId!: string | null;
  @IsOptional() @IsUUID() departmentId!: string | null;
  @IsOptional() @IsString() @MaxLength(1000) notes!: string | null;
}

export class RequisitionQuoteDto implements Required<RequisitionQuoteInput> {
  @IsUUID() vendorId!: string;
  @IsInt() @Min(0) @Max(MOST_CENTS) totalCents!: number;
  @ValidateIf(GIVEN) @IsString() @MaxLength(80) delivery!: string | null;
  @IsBoolean() chosen!: boolean;
}

/**
 * Every field of each contract input is named in its DTO: the validation pipe
 * refuses any field it does not know (purchasing.spec.ts runs the pipe).
 */
export class SaveRequisitionDto implements Required<SaveRequisitionInput> {
  @ValidateIf(GIVEN) @IsString() @MaxLength(80) xeroTenantId!: string | null;
  @ValidateIf(GIVEN) @Matches(DAY) neededBy!: string | null;
  @ValidateIf(GIVEN) @IsUUID() deliverToPlaceId!: string | null;
  @IsOptional() @IsUUID() requestCodeId!: string | null;
  @IsOptional() @IsUUID() costCenterId!: string | null;
  @IsOptional() @Matches(DAY) documentDate!: string | null;
  @IsString() @MaxLength(2000) reason!: string;
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_LINES) @ValidateNested({ each: true }) @Type(() => RequisitionLineDto) lines!: RequisitionLineDto[];
  @IsArray() @ArrayMaxSize(MOST_REQUISITION_QUOTES) @ValidateNested({ each: true }) @Type(() => RequisitionQuoteDto) quotes!: RequisitionQuoteDto[];
}

export class RequisitionDecisionDto implements Required<RequisitionDecisionInput> {
  @IsOptional() @IsString() @MaxLength(1000) note!: string | null;
}

export class SavePurchasingSettingsDto implements Required<SavePurchasingSettingsInput> {
  @IsInt() @Min(0) @Max(MOST_CENTS) approvalLimitCents!: number;
  @IsInt() @Min(0) @Max(MOST_REQUISITION_QUOTES) quotesAboveLimit!: number;
}

export class SetRequisitionFileDto implements Required<SetRequisitionFileInput> {
  @IsBoolean() forVendor!: boolean;
}

export class AddRequisitionNoteDto implements Required<AddRequisitionNoteInput> {
  @IsString() @MaxLength(REQUISITION_NOTE_MAX_LENGTH) text!: string;
}

export class AddRequisitionLinkDto implements Required<AddRequisitionLinkInput> {
  @IsString() @MaxLength(REQUISITION_LINK_MAX_LENGTH) url!: string;
  @IsString() @MaxLength(REQUISITION_LINK_TITLE_MAX_LENGTH) title!: string;
}

export class RequisitionListQueryDto {
  @IsOptional() @IsIn(['open', 'closed']) show?: 'open' | 'closed';
}

/**
 * Purchase requisitions (2026-11-19, phase 2). `purchasing:request` opens
 * Purchasing and is on every route; deciding adds `purchasing:approve`, and
 * the limits add `purchasing:approve-any`. No API key may hold any of them.
 * Whose requisition a caller may see or touch, and how much they may approve,
 * is decided in the service.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing')
export class PurchasingController {
  constructor(
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
    @Inject(RequisitionFilesService) private readonly files: RequisitionFilesService,
    @Inject(RequisitionNotesService) private readonly notes: RequisitionNotesService,
  ) {}

  // ── Notes, comments and links (2026-11-20) ──────────────────────────────

  @Post('requisitions/:requisitionId/notes')
  @RequirePermissions('purchasing:request')
  addNote(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: AddRequisitionNoteDto) {
    return this.notes.write(request.user, requisitionId, 'NOTE', body);
  }

  @Delete('requisitions/:requisitionId/notes/:noteId')
  @RequirePermissions('purchasing:request')
  removeNote(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Param('noteId', ParseUUIDPipe) noteId: string) {
    return this.notes.removeNote(request.user, requisitionId, noteId);
  }

  @Post('requisitions/:requisitionId/comments')
  @RequirePermissions('purchasing:request')
  comment(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: AddRequisitionNoteDto) {
    return this.notes.write(request.user, requisitionId, 'COMMENT', body);
  }

  @Post('requisitions/:requisitionId/links')
  @RequirePermissions('purchasing:request')
  addLink(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: AddRequisitionLinkDto) {
    return this.notes.addLink(request.user, requisitionId, body);
  }

  @Delete('requisitions/:requisitionId/links/:linkId')
  @RequirePermissions('purchasing:request')
  removeLink(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Param('linkId', ParseUUIDPipe) linkId: string) {
    return this.notes.removeLink(request.user, requisitionId, linkId);
  }

  /** "Cancel Approval Request": its requester takes it back while nobody has decided it. */
  @Post('requisitions/:requisitionId/recall')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  recall(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.recall(request.user, requisitionId);
  }

  /** "Reopen": an approved one with no order goes back to be changed, by its requester or an approver. */
  @Post('requisitions/:requisitionId/reopen')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  reopen(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.reopen(request.user, requisitionId, body);
  }

  // ── Files on a requisition (2026-11-20, part 3) ─────────────────────────

  /** One file a request; the page sends several one after another. Refused past 20 MB before it is read in full. */
  @Post('requisitions/:requisitionId/files')
  @RequirePermissions('purchasing:request')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: REQUISITION_FILE_MAX_BYTES, files: 1 } }))
  attachFile(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @UploadedFile() file?: UploadedRequisitionFile) {
    return this.files.attach(request.user, requisitionId, file);
  }

  @Get('requisitions/:requisitionId/files/:fileId/link')
  @RequirePermissions('purchasing:request')
  @Header('Cache-Control', 'private, no-store')
  fileLink(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    return this.files.link(request.user, requisitionId, fileId);
  }

  @Get('requisitions/:requisitionId/files/:fileId/content')
  @RequirePermissions('purchasing:request')
  @Header('Cache-Control', 'private, no-store')
  async fileContent(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    const file = await this.files.content(request.user, requisitionId, fileId);
    return new StreamableFile(file.bytes, { type: file.contentType, disposition: file.disposition });
  }

  @Patch('requisitions/:requisitionId/files/:fileId')
  @RequirePermissions('purchasing:request')
  setFile(
    @Req() request: AuthenticatedRequest,
    @Param('requisitionId', ParseUUIDPipe) requisitionId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Body() body: SetRequisitionFileDto,
  ) {
    return this.files.setForVendor(request.user, requisitionId, fileId, body.forVendor);
  }

  @Delete('requisitions/:requisitionId/files/:fileId')
  @RequirePermissions('purchasing:request')
  removeFile(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Param('fileId', ParseUUIDPipe) fileId: string) {
    return this.files.remove(request.user, requisitionId, fileId);
  }

  @Get('requisitions')
  @RequirePermissions('purchasing:request')
  list(@Req() request: AuthenticatedRequest, @Query() query: RequisitionListQueryDto) {
    return this.purchasing.list(request.user, query.show ?? 'open');
  }

  @Get('choices')
  @RequirePermissions('purchasing:request')
  choices(@Req() request: AuthenticatedRequest) {
    return this.purchasing.choices(request.user);
  }

  @Post('requisitions')
  @RequirePermissions('purchasing:request')
  create(@Req() request: AuthenticatedRequest, @Body() body: SaveRequisitionDto) {
    return this.purchasing.create(request.user, body);
  }

  @Get('requisitions/:requisitionId')
  @RequirePermissions('purchasing:request')
  detail(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.detail(request.user, requisitionId);
  }

  @Put('requisitions/:requisitionId')
  @RequirePermissions('purchasing:request')
  update(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: SaveRequisitionDto) {
    return this.purchasing.update(request.user, requisitionId, body);
  }

  @Post('requisitions/:requisitionId/submit')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  submit(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.submit(request.user, requisitionId);
  }

  @Post('requisitions/:requisitionId/cancel')
  @RequirePermissions('purchasing:request')
  @HttpCode(200)
  cancel(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string) {
    return this.purchasing.cancel(request.user, requisitionId);
  }

  @Post('requisitions/:requisitionId/approve')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'APPROVED', body);
  }

  @Post('requisitions/:requisitionId/send-back')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  sendBack(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'SENT_BACK', body);
  }

  @Post('requisitions/:requisitionId/reject')
  @RequirePermissions('purchasing:request', 'purchasing:approve')
  @HttpCode(200)
  reject(@Req() request: AuthenticatedRequest, @Param('requisitionId', ParseUUIDPipe) requisitionId: string, @Body() body: RequisitionDecisionDto) {
    return this.purchasing.decide(request.user, requisitionId, 'REJECTED', body);
  }

  @Put('settings')
  @RequirePermissions('purchasing:request', 'purchasing:approve', 'purchasing:approve-any')
  saveSettings(@Req() request: AuthenticatedRequest, @Body() body: SavePurchasingSettingsDto) {
    return this.purchasing.saveSettings(request.user, body);
  }
}
