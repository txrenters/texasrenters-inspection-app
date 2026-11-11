import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InvoiceDetail } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { InvoiceFileStorageService, invoiceFileKey } from '../common/invoice-file-storage.service';
import { PrismaService } from '../common/prisma.service';
import { InvoicesService } from './invoices.service';
import { readCompanies, shownInvoices } from './shown-invoices';

/**
 * Notes and files written on an invoice in the console (2026-11-10, phase 4
 * of the invoice gap review), beside the ones read from Jobber: Jobber's
 * "add notes, images and attachments". The office's own, so a re-read of
 * Jobber never touches them; only these can be taken off here.
 *
 * A file is kept in the console's private storage from the start and opened
 * through the same short-lived signed link as Jobber's copies. Nothing billed
 * is called.
 */

export const MAX_NOTE_LENGTH = 10_000;
export const MAX_INVOICE_FILE_BYTES = 10_000_000;

export interface UploadedInvoiceFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** What a file is by its first bytes, not by what the browser called it. */
export function sniffInvoiceFile(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(bytes.subarray(8, 12).toString('latin1')))
    return 'image/heic';
  return null;
}

/** A name a file keeps: printable, short, with its extension. */
export function cleanFileName(name: string, contentType: string) {
  const extension = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[contentType] ?? 'bin';
  const stem = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w .,()#&'-]+/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .trim()
    .slice(0, 120);
  return `${stem || 'File'}.${extension}`;
}

@Injectable()
export class InvoiceRecordsService {
  private readonly logger = new Logger(InvoiceRecordsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(InvoiceFileStorageService) private readonly storage: InvoiceFileStorageService,
  ) {}

  async addNote(user: AuthenticatedUser, invoiceId: string, message: string): Promise<InvoiceDetail> {
    const text = message.trim();
    if (!text) throw new ApplicationError(422, 'INVOICE_NOTE_INVALID', 'Write the note first.');
    if (text.length > MAX_NOTE_LENGTH) throw new ApplicationError(422, 'INVOICE_NOTE_INVALID', `Keep a note under ${MAX_NOTE_LENGTH} characters.`);
    await this.invoiceOf(user, invoiceId);
    await this.prisma.$transaction(async (tx) => {
      const note = await tx.invoiceNote.create({
        data: {
          organizationId: user.organizationId,
          invoiceId,
          origin: 'CONSOLE',
          jobberNoteId: null,
          createdById: user.id,
          kind: 'INVOICE',
          message: text,
          writtenAt: new Date(),
        },
        select: { id: true },
      });
      await this.audit(tx, user, invoiceId, 'INVOICE_NOTE_ADDED', { noteId: note.id, length: text.length });
    });
    return this.invoices.one(user, invoiceId);
  }

  async removeNote(user: AuthenticatedUser, invoiceId: string, noteId: string): Promise<InvoiceDetail> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoiceNote.deleteMany({
        where: { id: noteId, invoiceId, organizationId: user.organizationId, origin: 'CONSOLE' },
      });
      if (!count) throw new ApplicationError(404, 'INVOICE_NOTE_NOT_FOUND', 'That note is not one written here, or it is gone already.');
      await this.audit(tx, user, invoiceId, 'INVOICE_NOTE_REMOVED', { noteId });
    });
    return this.invoices.one(user, invoiceId);
  }

  async addFile(user: AuthenticatedUser, invoiceId: string, file: UploadedInvoiceFile | undefined): Promise<InvoiceDetail> {
    if (!file?.buffer?.length) throw new ApplicationError(422, 'INVOICE_FILE_INVALID', 'Choose a file to add.');
    if (file.size > MAX_INVOICE_FILE_BYTES || file.buffer.length > MAX_INVOICE_FILE_BYTES)
      throw new ApplicationError(422, 'INVOICE_FILE_INVALID', 'A file is at most 10 MB.');
    const contentType = sniffInvoiceFile(file.buffer);
    if (!contentType) throw new ApplicationError(422, 'INVOICE_FILE_INVALID', 'Add a photo (JPEG, PNG, WebP or HEIC) or a PDF.');
    await this.invoiceOf(user, invoiceId);
    if (!this.storage.durable())
      throw new ApplicationError(503, 'INVOICE_FILE_STORAGE_NOT_CONFIGURED', 'Private file storage is not configured.');

    const id = randomUUID();
    const storageKey = invoiceFileKey(user.organizationId, invoiceId, id);
    const fileName = cleanFileName(file.originalname, contentType);
    await this.storage.put(storageKey, file.buffer, contentType);
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.invoiceFile.create({
          data: {
            id,
            organizationId: user.organizationId,
            invoiceId,
            origin: 'CONSOLE',
            jobberFileId: null,
            uploadedById: user.id,
            fileName,
            contentType,
            sizeBytes: file.buffer.length,
            storageKey,
            uploadedAt: now,
            copiedAt: now,
          },
        });
        await this.audit(tx, user, invoiceId, 'INVOICE_FILE_ADDED', { fileId: id, fileName, contentType, sizeBytes: file.buffer.length });
      });
    } catch (error) {
      // Nothing points at the stored copy now: take it away again.
      await this.storage.delete(storageKey).catch(() => this.logger.warn({ event: 'invoice_file_orphaned', invoiceId }));
      throw error;
    }
    return this.invoices.one(user, invoiceId);
  }

  async removeFile(user: AuthenticatedUser, invoiceId: string, fileId: string): Promise<InvoiceDetail> {
    const file = await this.prisma.invoiceFile.findFirst({
      where: { id: fileId, invoiceId, organizationId: user.organizationId, origin: 'CONSOLE' },
      select: { id: true, fileName: true, storageKey: true },
    });
    if (!file) throw new ApplicationError(404, 'INVOICE_FILE_NOT_FOUND', 'That file is not one added here, or it is gone already.');
    await this.prisma.$transaction(async (tx) => {
      await tx.invoiceFile.delete({ where: { id: file.id } });
      await this.audit(tx, user, invoiceId, 'INVOICE_FILE_REMOVED', { fileId, fileName: file.fileName });
    });
    if (file.storageKey)
      await this.storage.delete(file.storageKey).catch(() => this.logger.warn({ event: 'invoice_file_not_deleted', invoiceId, fileId }));
    return this.invoices.one(user, invoiceId);
  }

  private async invoiceOf(user: AuthenticatedUser, invoiceId: string) {
    const read = await readCompanies(this.prisma, user.organizationId);
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, organizationId: user.organizationId, ...shownInvoices(read) },
      select: { id: true },
    });
    if (!invoice) throw new ApplicationError(404, 'INVOICE_NOT_FOUND', 'That invoice was not found.');
    return invoice;
  }

  private audit(
    tx: Pick<PrismaService, 'auditLog'>,
    user: AuthenticatedUser,
    invoiceId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return tx.auditLog.create({
      data: { organizationId: user.organizationId, actorUserId: user.id, action, entityType: 'Invoice', entityId: invoiceId, metadata: metadata as never },
    });
  }
}
