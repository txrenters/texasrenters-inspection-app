import { Body, Controller, Get, Inject, Param, ParseEnumPipe, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  APPROVAL_STEP_APPROVERS,
  DOCUMENT_SERIES_KINDS,
  FILE_GROUP_KEYS,
  FILE_REMOVALS,
  FILE_SIZE_CHOICES,
  MOST_APPROVAL_STEPS,
  MOST_FILES_A_REQUISITION,
  MOST_PREFIX_LENGTH,
  MOST_REMINDER_DAYS,
  MOST_REQUISITION_QUOTES,
  MOST_SERIES_DIGITS,
  LEAST_SERIES_DIGITS,
  type ApprovalStep,
  type ApprovalStepApprover,
  type DocumentSeriesKind,
  type FileGroup,
  type FileRemoval,
  type SaveDocumentSeriesInput,
  type SavePurchasingApprovalsInput,
  type SaveRequisitionFileRulesInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchasingSetupService } from './purchasing-setup.service';

/** The most a step's top may be: a billion dollars, in cents, inside a 32-bit column. */
const MOST_CENTS = 2_000_000_000;
/** Null is "no top" or "no reminder". */
const GIVEN = (_: object, value: unknown) => value !== null;

/** Every field of the contract input is named: the validation pipe refuses any field it does not know. */
export class ApprovalStepDto implements Required<ApprovalStep> {
  @ValidateIf(GIVEN) @IsInt() @Min(1) @Max(MOST_CENTS) upToCents!: number | null;
  @IsIn(APPROVAL_STEP_APPROVERS) approver!: ApprovalStepApprover;
  @IsInt() @Min(0) @Max(MOST_REQUISITION_QUOTES) quotesNeeded!: number;
  @ValidateIf(GIVEN) @IsInt() @Min(1) @Max(MOST_REMINDER_DAYS) reminderDays!: number | null;
}

export class SavePurchasingApprovalsDto implements Required<SavePurchasingApprovalsInput> {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MOST_APPROVAL_STEPS) @ValidateNested({ each: true }) @Type(() => ApprovalStepDto) steps!: ApprovalStepDto[];
  @IsBoolean() emailApprovers!: boolean;
  @IsBoolean() reapproveChangedOrders!: boolean;
}

export class SaveRequisitionFileRulesDto implements Required<SaveRequisitionFileRulesInput> {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(FILE_GROUP_KEYS.length) @IsIn(FILE_GROUP_KEYS, { each: true }) groups!: FileGroup[];
  @IsIn(FILE_SIZE_CHOICES) maxBytes!: number;
  @IsInt() @Min(1) @Max(MOST_FILES_A_REQUISITION) maxFiles!: number;
  @ValidateIf(GIVEN) @IsInt() @Min(0) @Max(MOST_CENTS) quoteFileAboveCents!: number | null;
  @IsIn(FILE_REMOVALS) removal!: FileRemoval;
}

export class SaveDocumentSeriesDto implements Required<SaveDocumentSeriesInput> {
  @IsString() @MinLength(1) @MaxLength(MOST_PREFIX_LENGTH) prefix!: string;
  @IsInt() @Min(LEAST_SERIES_DIGITS) @Max(MOST_SERIES_DIGITS) digits!: number;
  @IsInt() @Min(1) @Max(99_999_999) next!: number;
}

/**
 * Purchasing Setup (2026-11-20, part 5a): only a system admin or a Purchasing
 * admin (`purchasing:setup`) reads or changes it. Each section saves on its
 * own; the service checks every rule again and audits each change.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/purchasing/setup')
export class PurchasingSetupController {
  constructor(@Inject(PurchasingSetupService) private readonly setup: PurchasingSetupService) {}

  @Get()
  @RequirePermissions('purchasing:setup')
  read(@Req() request: AuthenticatedRequest) {
    return this.setup.read(request.user);
  }

  @Put('approvals')
  @RequirePermissions('purchasing:setup')
  saveApprovals(@Req() request: AuthenticatedRequest, @Body() body: SavePurchasingApprovalsDto) {
    return this.setup.saveApprovals(request.user, body);
  }

  @Put('files')
  @RequirePermissions('purchasing:setup')
  saveFiles(@Req() request: AuthenticatedRequest, @Body() body: SaveRequisitionFileRulesDto) {
    return this.setup.saveFiles(request.user, body);
  }

  @Put('numbers/:kind')
  @RequirePermissions('purchasing:setup')
  saveSeries(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(Object.fromEntries(DOCUMENT_SERIES_KINDS.map((kind) => [kind, kind])))) kind: DocumentSeriesKind,
    @Body() body: SaveDocumentSeriesDto,
  ) {
    return this.setup.saveSeries(request.user, kind, body);
  }
}
