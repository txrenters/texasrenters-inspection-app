import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PurchaseRequisitionStatus as Status } from '@prisma/client';
import {
  REQUISITION_FILE_MAX_BYTES,
  fileGroupOf,
  fileGroupsSaying,
  formatFileSize,
  type RequisitionDetail,
  type RequisitionFileLink,
  type RequisitionFileType,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { PurchasingFileStorageService, requisitionFileKey } from '../common/purchasing-file-storage.service';
import { cleanFileName } from './invoice-records.service';
import { PurchasingService, visibleRequisitions } from './purchasing.service';
import { readPurchasingSettings } from './purchasing-settings';
import { ATTACHABLE, fileDisposition, fileExtension, filesRemovable, sniffRequisitionFile } from './requisition-files';

/** How long a link to a file lasts: long enough to open, too short to pass around. */
const LINK_SECONDS = 300;
const ENTITY = 'PurchaseRequisition';

/** The shape multer hands over, kept here so the controller need not import it. */
export interface UploadedRequisitionFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Files attached to a purchase requisition (2026-11-20, part 3 of the NAV-style
 * requisition): quotes, pictures of the shelf, the list the vendor sent.
 *
 * - Anybody who sees the requisition attaches files and ticks which go to the
 *   vendor, until it is finished with (rejected, cancelled or closed).
 * - Whoever attached a file takes it off, and only while the requisition is
 *   still being written: once sent, what the approver saw stays.
 * - A file is what its first bytes say, at most 20 MB, at most 20 a requisition.
 *
 * Each file is stored once (one storage write), opened through a signed link
 * worked out here (no call), and every step is audited, so the requisition's
 * history shows it. Nothing billed is called.
 */
@Injectable()
export class RequisitionFilesService {
  private readonly logger = new Logger(RequisitionFilesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PurchasingFileStorageService) private readonly storage: PurchasingFileStorageService,
    @Inject(PurchasingService) private readonly purchasing: PurchasingService,
  ) {}

  async attach(user: AuthenticatedUser, requisitionId: string, file: UploadedRequisitionFile | undefined): Promise<RequisitionDetail> {
    if (!file?.buffer?.length) throw new ApplicationError(422, 'REQUISITION_FILE_INVALID', 'Choose a file to attach.');
    // The office's rules (Purchasing Setup, 2026-11-20): the kinds it allows, the largest file, how many.
    const { files: rules } = await readPurchasingSettings(this.prisma, user.organizationId);
    const most = Math.min(rules.maxBytes, REQUISITION_FILE_MAX_BYTES);
    if (file.size > most || file.buffer.length > most)
      throw new ApplicationError(422, 'REQUISITION_FILE_TOO_BIG', `A file is at most ${formatFileSize(most)}; this one is ${formatFileSize(file.buffer.length)}.`);
    const contentType = sniffRequisitionFile(file.buffer);
    const group = contentType ? fileGroupOf(contentType) : null;
    if (!contentType || !group || !rules.groups.includes(group))
      throw new ApplicationError(422, 'REQUISITION_FILE_INVALID', `Attach ${fileGroupsSaying(rules.groups).replace(/, ([^,]*)$/, ' or $1')}.`);
    const requisition = await this.requisitionOf(user, requisitionId);
    this.assertAttachable(requisition.status);
    await this.assertRoom(this.prisma, user.organizationId, requisitionId, rules.maxFiles);
    if (!this.storage.durable()) throw new ApplicationError(503, 'REQUISITION_FILE_STORAGE_NOT_CONFIGURED', 'Private file storage is not configured.');

    const id = randomUUID();
    const storageKey = requisitionFileKey(user.organizationId, requisitionId, id);
    const fileName = cleanFileName(file.originalname, contentType, fileExtension(contentType));
    await this.storage.put(storageKey, file.buffer, contentType);
    try {
      await this.prisma.$transaction(async (tx) => {
        // One at a time per requisition, so two attached at once cannot pass the limit together.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`requisition-files:${requisitionId}`}, 0))::text AS locked`;
        const current = await tx.purchaseRequisition.findFirst({ where: { id: requisitionId, organizationId: user.organizationId }, select: { status: true } });
        this.assertAttachable(current?.status);
        await this.assertRoom(tx, user.organizationId, requisitionId, rules.maxFiles);
        await tx.purchaseRequisitionFile.create({
          data: { id, organizationId: user.organizationId, requisitionId, fileName, contentType, sizeBytes: file.buffer.length, storageKey, attachedById: user.id },
        });
        await this.audit(tx, user, 'PURCHASE_REQUISITION_FILE_ATTACHED', requisitionId, { fileId: id, note: fileName, contentType, sizeBytes: file.buffer.length });
      });
    } catch (error) {
      // Nothing points at the stored copy now: take it away again.
      await this.storage.delete(storageKey).catch(() => this.logger.warn({ event: 'requisition_file_orphaned', requisitionId }));
      throw error;
    }
    return this.purchasing.detail(user, requisitionId);
  }

  /** A link that opens the file for five minutes; null where files are kept on the API's own disk. */
  async link(user: AuthenticatedUser, requisitionId: string, fileId: string): Promise<RequisitionFileLink> {
    const file = await this.fileOf(user, requisitionId, fileId);
    return { url: await this.storage.signedUrl(file.storageKey, LINK_SECONDS, fileDisposition(file.fileName, file.contentType as RequisitionFileType)) };
  }

  /** The bytes themselves, for where there is no link to give. */
  async content(user: AuthenticatedUser, requisitionId: string, fileId: string) {
    const file = await this.fileOf(user, requisitionId, fileId);
    const contentType = file.contentType as RequisitionFileType;
    return { bytes: await this.storage.get(file.storageKey), contentType, disposition: fileDisposition(file.fileName, contentType) };
  }

  /** Tick or untick a file to go to the vendor with the purchase order. A tick that changes nothing writes nothing. */
  async setForVendor(user: AuthenticatedUser, requisitionId: string, fileId: string, forVendor: boolean): Promise<RequisitionDetail> {
    const requisition = await this.requisitionOf(user, requisitionId);
    this.assertAttachable(requisition.status);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.purchaseRequisitionFile.updateMany({
        where: { id: fileId, requisitionId, organizationId: user.organizationId, forVendor: !forVendor },
        data: { forVendor },
      });
      if (!count) {
        const there = await tx.purchaseRequisitionFile.findFirst({ where: { id: fileId, requisitionId, organizationId: user.organizationId }, select: { id: true } });
        if (!there) throw this.notFound();
        return;
      }
      const file = await tx.purchaseRequisitionFile.findFirst({ where: { id: fileId, organizationId: user.organizationId }, select: { fileName: true } });
      await this.audit(tx, user, forVendor ? 'PURCHASE_REQUISITION_FILE_FOR_VENDOR' : 'PURCHASE_REQUISITION_FILE_NOT_FOR_VENDOR', requisitionId, { fileId, note: file?.fileName ?? null });
    });
    return this.purchasing.detail(user, requisitionId);
  }

  /** Take a file off: only whoever attached it, while the requisition is still being written. */
  async remove(user: AuthenticatedUser, requisitionId: string, fileId: string): Promise<RequisitionDetail> {
    const requisition = await this.requisitionOf(user, requisitionId);
    const file = await this.fileOf(user, requisitionId, fileId);
    if (file.attachedById !== user.id) throw new ApplicationError(403, 'REQUISITION_FILE_NOT_YOURS', 'Only whoever attached a file takes it off.');
    const { files: rules } = await readPurchasingSettings(this.prisma, user.organizationId);
    if (!filesRemovable(rules.removal).includes(requisition.status))
      throw new ApplicationError(409, 'REQUISITION_FILE_KEPT', `This requisition has been ${rules.removal === 'UNTIL_ORDERED' ? 'ordered' : 'sent'}, so its files stay with it.`);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.purchaseRequisitionFile.deleteMany({ where: { id: fileId, requisitionId, organizationId: user.organizationId } });
      if (!count) throw this.notFound();
      await this.audit(tx, user, 'PURCHASE_REQUISITION_FILE_REMOVED', requisitionId, { fileId, note: file.fileName });
    });
    await this.storage.delete(file.storageKey).catch(() => this.logger.warn({ event: 'requisition_file_not_deleted', requisitionId, fileId }));
    return this.purchasing.detail(user, requisitionId);
  }

  /** The requisition, if the caller sees it: somebody else's draft, or another office's, is simply not there. */
  private async requisitionOf(user: AuthenticatedUser, requisitionId: string) {
    const requisition = await this.prisma.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId: user.organizationId, AND: [visibleRequisitions(user)] },
      select: { id: true, status: true },
    });
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
    return requisition;
  }

  private async fileOf(user: AuthenticatedUser, requisitionId: string, fileId: string) {
    await this.requisitionOf(user, requisitionId);
    const file = await this.prisma.purchaseRequisitionFile.findFirst({
      where: { id: fileId, requisitionId, organizationId: user.organizationId },
      select: { id: true, fileName: true, contentType: true, storageKey: true, attachedById: true },
    });
    if (!file) throw this.notFound();
    return file;
  }

  private assertAttachable(status: Status | undefined) {
    if (!status || !ATTACHABLE.includes(status))
      throw new ApplicationError(409, 'REQUISITION_FILES_CLOSED', 'This requisition is finished with, so nothing more is attached to it.');
  }

  private async assertRoom(db: Pick<PrismaService, 'purchaseRequisitionFile'>, organizationId: string, requisitionId: string, most: number) {
    const held = await db.purchaseRequisitionFile.count({ where: { organizationId, requisitionId } });
    if (held >= most) throw new ApplicationError(409, 'REQUISITION_FILES_FULL', `A requisition holds at most ${most} files. Take one off first.`);
  }

  private notFound() {
    return new ApplicationError(404, 'REQUISITION_FILE_NOT_FOUND', 'That file is not on this requisition.');
  }

  private audit(db: Pick<PrismaService, 'auditLog'>, user: AuthenticatedUser, action: string, requisitionId: string, metadata: Record<string, unknown>) {
    return db.auditLog.create({
      data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: ENTITY, entityId: requisitionId, metadata: metadata as never },
    });
  }
}
