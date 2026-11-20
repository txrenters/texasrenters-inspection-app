import { Body, Controller, Get, HttpCode, Inject, Param, ParseEnumPipe, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
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
  PURCHASING_ROLE_KEYS,
  type AddPurchasingPersonInput,
  type ApprovalStep,
  type ApprovalStepApprover,
  type DocumentSeriesKind,
  type FileGroup,
  type FileRemoval,
  type PurchasingRoleKey,
  KEEPER_ROLES,
  FACT_BOX_KEYS,
  PURCHASING_ROLE_KEYS as ROLE_KEYS,
  type FactBoxKey,
  type FactBoxSetting,
  type KeeperRole,
  type RequisitionFieldKey,
  type RequisitionFieldSetting,
  type SaveCodeKeepersInput,
  type SaveRequisitionPageInput,
  type SaveDocumentSeriesInput,
  type SavePurchasingPersonInput,
  type SavePurchasingApprovalsInput,
  type SaveRequisitionFileRulesInput,
  type SetPurchasingRoleInput,
} from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PurchasingPeopleService } from './purchasing-people.service';
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
  @IsBoolean() approverOwnCompaniesOnly!: boolean;
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

/** Each list's keeper; the service checks every list is named, and with a role the board offers. */
export class CodeKeepersDto {
  @IsIn(KEEPER_ROLES) ITEMS!: KeeperRole;
  @IsIn(KEEPER_ROLES) CATEGORIES!: KeeperRole;
  @IsIn(KEEPER_ROLES) LINE_TYPES!: KeeperRole;
  @IsIn(KEEPER_ROLES) UNITS!: KeeperRole;
  @IsIn(KEEPER_ROLES) REQUEST!: KeeperRole;
  @IsIn(KEEPER_ROLES) DEPARTMENT!: KeeperRole;
  @IsIn(KEEPER_ROLES) COST_CENTER!: KeeperRole;
  @IsIn(KEEPER_ROLES) PLACES!: KeeperRole;
  @IsIn(KEEPER_ROLES) VENDORS!: KeeperRole;
  @IsIn(KEEPER_ROLES) PURCHASER_CODES!: KeeperRole;
}

export class SaveCodeKeepersDto implements Required<SaveCodeKeepersInput> {
  @ValidateNested() @Type(() => CodeKeepersDto) keepers!: CodeKeepersDto;
}

export class RequisitionFieldSettingDto implements Required<RequisitionFieldSetting> {
  @IsBoolean() shown!: boolean;
  @IsBoolean() required!: boolean;
}

export class RequisitionFieldsDto implements Record<RequisitionFieldKey, RequisitionFieldSettingDto> {
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) REQUEST_CODE!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) COST_CENTER!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) DOCUMENT_DATE!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) EXPECTED_RECEIPT!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) LINE_DEPARTMENT!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) LINE_NOTES!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) LOCATION!: RequisitionFieldSettingDto;
  @ValidateNested() @Type(() => RequisitionFieldSettingDto) COMPANY!: RequisitionFieldSettingDto;
}

export class FactBoxSettingDto implements Required<FactBoxSetting> {
  @IsIn(FACT_BOX_KEYS) key!: FactBoxKey;
  @IsBoolean() shown!: boolean;
  @IsArray() @ArrayMaxSize(ROLE_KEYS.length) @IsIn(ROLE_KEYS, { each: true }) audience!: FactBoxSetting['audience'];
}

export class SaveRequisitionPageDto implements Required<SaveRequisitionPageInput> {
  @ValidateNested() @Type(() => RequisitionFieldsDto) fields!: RequisitionFieldsDto;
  @IsArray() @ArrayMinSize(FACT_BOX_KEYS.length) @ArrayMaxSize(FACT_BOX_KEYS.length) @ValidateNested({ each: true }) @Type(() => FactBoxSettingDto) factBoxes!: FactBoxSettingDto[];
}

export class SetPurchasingRoleDto implements Required<SetPurchasingRoleInput> {
  @IsBoolean() held!: boolean;
}

export class SavePurchasingPersonDto implements Required<SavePurchasingPersonInput> {
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(80, { each: true }) companyTenantIds!: string[];
  @IsBoolean() approvesAnyAmount!: boolean;
  @ValidateIf(GIVEN) @IsInt() @Min(1) @Max(MOST_CENTS) approvalLimitCents!: number | null;
}

export class AddPurchasingPersonDto implements Required<AddPurchasingPersonInput> {
  @IsUUID() userProfileId!: string;
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
  constructor(
    @Inject(PurchasingSetupService) private readonly setup: PurchasingSetupService,
    @Inject(PurchasingPeopleService) private readonly people: PurchasingPeopleService,
  ) {}

  // ── Roles and who holds them (part 5b, 2026-11-21) ──────────────────────

  @Get('people')
  @RequirePermissions('purchasing:setup')
  readPeople(@Req() request: AuthenticatedRequest) {
    return this.people.people(request.user);
  }

  @Post('people')
  @RequirePermissions('purchasing:setup')
  @HttpCode(200)
  addPerson(@Req() request: AuthenticatedRequest, @Body() body: AddPurchasingPersonDto) {
    return this.people.addPerson(request.user, body);
  }

  @Put('people/:personId')
  @RequirePermissions('purchasing:setup')
  savePerson(@Req() request: AuthenticatedRequest, @Param('personId', ParseUUIDPipe) personId: string, @Body() body: SavePurchasingPersonDto) {
    return this.people.savePerson(request.user, personId, body);
  }

  @Put('people/:personId/roles/:role')
  @RequirePermissions('purchasing:setup')
  setRole(
    @Req() request: AuthenticatedRequest,
    @Param('personId', ParseUUIDPipe) personId: string,
    @Param('role', new ParseEnumPipe(Object.fromEntries(PURCHASING_ROLE_KEYS.map((key) => [key, key])))) role: PurchasingRoleKey,
    @Body() body: SetPurchasingRoleDto,
  ) {
    return this.people.setRole(request.user, personId, role, body.held);
  }

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

  @Put('codes')
  @RequirePermissions('purchasing:setup')
  saveCodeKeepers(@Req() request: AuthenticatedRequest, @Body() body: SaveCodeKeepersDto) {
    return this.setup.saveCodeKeepers(request.user, body);
  }

  @Put('page')
  @RequirePermissions('purchasing:setup')
  saveRequisitionPage(@Req() request: AuthenticatedRequest, @Body() body: SaveRequisitionPageDto) {
    return this.setup.saveRequisitionPage(request.user, body);
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
