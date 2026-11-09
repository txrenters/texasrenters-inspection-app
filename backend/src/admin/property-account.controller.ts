import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MAX_INVOICE_RECIPIENTS, MAX_STATEMENT_DISCLAIMER, type StatementPeriod } from '@texasrenters/shared';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { PropertyAccountService } from './property-account.service';

const PERIODS: StatementPeriod[] = ['LIFETIME', 'SINCE_ZERO', 'FROM'];

export class StatementQueryDto {
  @IsIn(PERIODS) period!: StatementPeriod;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
}

export class SendStatementDto extends StatementQueryDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVOICE_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(254, { each: true })
  to!: string[];
  @IsString() @MinLength(8) @MaxLength(120) clientRequestId!: string;
}

export class SaveStatementSettingsDto {
  @IsBoolean() newestFirst!: boolean;
  @IsOptional() @IsString() @MaxLength(MAX_STATEMENT_DISCLAIMER) disclaimer?: string | null;
  @IsOptional() @IsISO8601() expectedUpdatedAt?: string | null;
}

/**
 * A property's account and its statement (2026-11-10, phase 3 of the invoice
 * gap review). Read with `invoices:read`; a statement is emailed -- a billed
 * call -- only with `invoices:manage` too, which an API key never holds.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/properties')
export class PropertyAccountController {
  constructor(@Inject(PropertyAccountService) private readonly accounts: PropertyAccountService) {}

  @Get(':propertyId/account')
  @RequirePermissions('invoices:read')
  account(@Req() request: AuthenticatedRequest, @Param('propertyId', new ParseUUIDPipe()) propertyId: string) {
    return this.accounts.account(request.user, propertyId);
  }

  @Get(':propertyId/statement')
  @RequirePermissions('invoices:read')
  statement(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId', new ParseUUIDPipe()) propertyId: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.accounts.statement(request.user, propertyId, { period: query.period, from: query.from ?? null });
  }

  @Post(':propertyId/statement')
  @RequirePermissions('invoices:read', 'invoices:manage')
  send(
    @Req() request: AuthenticatedRequest,
    @Param('propertyId', new ParseUUIDPipe()) propertyId: string,
    @Body() body: SendStatementDto,
  ) {
    return this.accounts.sendStatement(request.user, propertyId, { ...body, from: body.from ?? null });
  }
}

@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-settings')
export class StatementSettingsController {
  constructor(@Inject(PropertyAccountService) private readonly accounts: PropertyAccountService) {}

  @Get('statements')
  @RequirePermissions('invoices:read')
  read(@Req() request: AuthenticatedRequest) {
    return this.accounts.settings(request.user);
  }

  @Put('statements')
  @RequirePermissions('invoices:read', 'invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveStatementSettingsDto) {
    return this.accounts.saveSettings(request.user, {
      newestFirst: body.newestFirst,
      disclaimer: body.disclaimer ?? null,
      expectedUpdatedAt: body.expectedUpdatedAt ?? null,
    });
  }
}
