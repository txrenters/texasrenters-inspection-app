import { PurchaseRequisitionStatus as Status, type Prisma } from '@prisma/client';
import {
  REQUISITION_FILE_TYPES,
  requisitionerCode,
  type RequisitionFile,
  type FileRemoval,
  type RequisitionFileType,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';

/**
 * The files on a purchase requisition, as the requisition and its order read
 * them (2026-11-20, part 3). Kept apart from the service that stores them so
 * the requisition and the purchase order can read them without the storage.
 */

type Db = Prisma.TransactionClient;

/** A file can be attached, and ticked for the vendor, until the requisition is finished with. */
export const ATTACHABLE: readonly Status[] = [Status.DRAFT, Status.SUBMITTED, Status.SENT_BACK, Status.APPROVED, Status.ORDERED];
/**
 * Whoever attached a file may take it off while the requisition is still being
 * written -- or, if the office says so in Purchasing Setup (2026-11-20), until
 * it is ordered. After that it stays on the record.
 */
export function filesRemovable(removal: FileRemoval): readonly Status[] {
  return removal === 'UNTIL_ORDERED' ? [Status.DRAFT, Status.SUBMITTED, Status.SENT_BACK, Status.APPROVED] : [Status.DRAFT, Status.SENT_BACK];
}

const FILE = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  forVendor: true,
  attachedAt: true,
  attachedById: true,
  attachedBy: { select: { displayName: true } },
} satisfies Prisma.PurchaseRequisitionFileSelect;

/** A requisition's files, oldest first, with what the caller may do to each. */
export async function requisitionFiles(db: Pick<Db, 'purchaseRequisitionFile' | 'purchasingSettings'>, user: AuthenticatedUser, requisition: { id: string; status: Status }): Promise<RequisitionFile[]> {
  const [rows, rules] = await Promise.all([
    db.purchaseRequisitionFile.findMany({
      where: { organizationId: user.organizationId, requisitionId: requisition.id },
      select: FILE,
      orderBy: [{ attachedAt: 'asc' }, { id: 'asc' }],
    }),
    db.purchasingSettings.findUnique({ where: { organizationId: user.organizationId }, select: { fileRemoval: true } }),
  ]);
  const removable = filesRemovable(rules?.fileRemoval === 'UNTIL_ORDERED' ? 'UNTIL_ORDERED' : 'UNTIL_SENT');
  return rows.map((row) => ({
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType as RequisitionFileType,
    sizeBytes: row.sizeBytes,
    attachedBy: { id: row.attachedById, name: row.attachedBy.displayName, code: requisitionerCode(row.attachedBy.displayName) },
    attachedAt: row.attachedAt.toISOString(),
    forVendor: row.forVendor,
    canRemove: row.attachedById === user.id && removable.includes(requisition.status),
  }));
}

/** The requisition's files ticked to go to the vendor, oldest first: what a purchase order's email carries beside its PDF. */
export function vendorFilesOf(db: Pick<Db, 'purchaseRequisitionFile'>, organizationId: string, requisitionId: string) {
  return db.purchaseRequisitionFile.findMany({
    where: { organizationId, requisitionId, forVendor: true },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, storageKey: true },
    orderBy: [{ attachedAt: 'asc' }, { id: 'asc' }],
  });
}

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * What a file is by its bytes, never by what the browser called it: a PDF, a
 * picture, or a Word or Excel file. Null for anything else -- a web page or a
 * program renamed ".pdf" is refused.
 *
 * Word and Excel files of today are zip archives, told apart by the part each
 * must hold. The older ones share one container, told apart by the stream each
 * must hold, written in UTF-16 in its directory.
 */
export function sniffRequisitionFile(bytes: Buffer): RequisitionFileType | null {
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(bytes.subarray(8, 12).toString('latin1')))
    return 'image/heic';
  if (bytes.subarray(0, 4).equals(ZIP)) {
    if (bytes.includes('word/document.xml', 0, 'latin1')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (bytes.includes('xl/workbook.xml', 0, 'latin1')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return null;
  }
  if (bytes.subarray(0, 8).equals(OLE)) {
    if (bytes.includes(Buffer.from('WordDocument', 'utf16le'))) return 'application/msword';
    if (bytes.includes(Buffer.from('Workbook', 'utf16le')) || bytes.includes(Buffer.from('Book', 'utf16le'))) return 'application/vnd.ms-excel';
    return null;
  }
  return null;
}

/** The ending a file of each kind keeps: "pdf", "jpg", "xlsx". */
export const fileExtension = (contentType: RequisitionFileType) => REQUISITION_FILE_TYPES[contentType].toLowerCase();

/** How a browser opens it: a PDF or a picture in place, a Word or Excel file as a download, both under its own name. */
export function fileDisposition(fileName: string, contentType: RequisitionFileType) {
  const plain = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'file';
  const how = contentType === 'application/pdf' || contentType.startsWith('image/') ? 'inline' : 'attachment';
  return `${how}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
