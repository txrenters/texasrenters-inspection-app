import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MAX_TEMPLATE_MESSAGE, MAX_TEMPLATE_SUBJECT } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

import { ApiAuthGuard, PermissionsGuard, RequirePermissions, type AuthenticatedRequest } from '../common/auth';
import { InvoiceRecordsService, MAX_INVOICE_FILE_BYTES, MAX_NOTE_LENGTH, type UploadedInvoiceFile } from './invoice-records.service';
import { InvoiceTemplatesService } from './invoice-templates.service';

export class AddInvoiceNoteDto {
  @IsString() @MinLength(1) @MaxLength(MAX_NOTE_LENGTH) message!: string;
}

export class EmailTemplateDto {
  @IsString() @MinLength(1) @MaxLength(MAX_TEMPLATE_SUBJECT) subject!: string;
  @IsString() @MaxLength(MAX_TEMPLATE_MESSAGE) message!: string;
}

export class EmailTemplatesDto {
  @ValidateNested() @Type(() => EmailTemplateDto) invoice!: EmailTemplateDto;
  @ValidateNested() @Type(() => EmailTemplateDto) receipt!: EmailTemplateDto;
  @ValidateNested() @Type(() => EmailTemplateDto) statement!: EmailTemplateDto;
}

export class SaveEmailTemplatesDto {
  @ValidateNested() @Type(() => EmailTemplatesDto) templates!: EmailTemplatesDto;
  @IsOptional() @IsString() @MaxLength(254) replyTo?: string | null;
  @IsOptional() @IsISO8601() expectedUpdatedAt?: string | null;
}

/**
 * Notes and files written on an invoice in the console (2026-11-10, phase 4
 * of the invoice gap review). Read with the invoice; written and taken off by
 * whoever makes invoices, which an API key never is.
 */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoices')
export class InvoiceRecordsController {
  constructor(@Inject(InvoiceRecordsService) private readonly records: InvoiceRecordsService) {}

  @Post(':invoiceId/notes')
  @RequirePermissions('invoices:read', 'invoices:manage')
  addNote(@Req() request: AuthenticatedRequest, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @Body() body: AddInvoiceNoteDto) {
    return this.records.addNote(request.user, invoiceId, body.message);
  }

  @Delete(':invoiceId/notes/:noteId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  removeNote(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Param('noteId', new ParseUUIDPipe()) noteId: string,
  ) {
    return this.records.removeNote(request.user, invoiceId, noteId);
  }

  @Post(':invoiceId/files')
  @RequirePermissions('invoices:read', 'invoices:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_INVOICE_FILE_BYTES, files: 1 } }))
  addFile(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @UploadedFile() file?: UploadedInvoiceFile,
  ) {
    return this.records.addFile(request.user, invoiceId, file);
  }

  @Delete(':invoiceId/files/:fileId')
  @RequirePermissions('invoices:read', 'invoices:manage')
  removeFile(
    @Req() request: AuthenticatedRequest,
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ) {
    return this.records.removeFile(request.user, invoiceId, fileId);
  }
}

/** The office's email words (2026-11-10): read with invoices, changed by whoever makes them. */
@ApiTags('Administrator application')
@ApiBearerAuth()
@UseGuards(ApiAuthGuard, PermissionsGuard)
@Controller('admin/invoice-settings')
export class InvoiceTemplatesController {
  constructor(@Inject(InvoiceTemplatesService) private readonly templates: InvoiceTemplatesService) {}

  @Get('email-templates')
  @RequirePermissions('invoices:read')
  read(@Req() request: AuthenticatedRequest) {
    return this.templates.read(request.user);
  }

  @Put('email-templates')
  @RequirePermissions('invoices:read', 'invoices:manage')
  save(@Req() request: AuthenticatedRequest, @Body() body: SaveEmailTemplatesDto) {
    return this.templates.save(request.user, {
      templates: body.templates,
      replyTo: body.replyTo ?? null,
      expectedUpdatedAt: body.expectedUpdatedAt ?? null,
    });
  }
}
