import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';

import { ObjectStorage, type StorageProvider } from './object-storage';

const LOCAL_ROOT = resolve(process.cwd(), '.local-invoice-files');

/** Where the inspection media is kept, which invoice files follow unless told otherwise. */
const MEDIA_PROVIDER_ENV = 'INSPECTION_MEDIA_STORAGE_PROVIDER';
const MEDIA_BUCKET_DEFAULT = 'inspection-media';

/**
 * The console's own copies of the files on Jobber's invoices (2026-11-06,
 * phase 7 of taking invoicing over from Jobber).
 *
 * Kept where the inspection photos and videos are -- the same private bucket
 * and provider, under `invoice-files/` -- so production needs nothing new to
 * set up; `INVOICE_FILE_STORAGE_PROVIDER` and `INVOICE_FILE_STORAGE_BUCKET`
 * put them elsewhere. Opened only through short-lived signed links.
 */
@Injectable()
export class InvoiceFileStorageService extends ObjectStorage {
  constructor() {
    super({
      providerEnv: 'INVOICE_FILE_STORAGE_PROVIDER',
      bucketEnv: 'INVOICE_FILE_STORAGE_BUCKET',
      defaultBucket: process.env.INSPECTION_MEDIA_STORAGE_BUCKET || MEDIA_BUCKET_DEFAULT,
      localRoot: LOCAL_ROOT,
      notFoundCode: 'INVOICE_FILE_NOT_FOUND',
      notFoundMessage: 'That file was not found.',
      writeFailedCode: 'INVOICE_FILE_STORAGE_FAILED',
      writeFailedMessage: 'The file could not be stored.',
      notConfiguredCode: 'INVOICE_FILE_STORAGE_NOT_CONFIGURED',
      notConfiguredMessage: 'Private file storage is not configured.',
      invalidKeyCode: 'INVALID_STORAGE_KEY',
      invalidKeyMessage: 'Invalid invoice file storage key.',
    });
  }

  /** The invoice files' own provider when one is named, else the inspection media's. */
  override providerName(): StorageProvider {
    const value = process.env.INVOICE_FILE_STORAGE_PROVIDER?.trim() || process.env[MEDIA_PROVIDER_ENV];
    return value === 'r2' ? 'r2' : 'local';
  }

  /**
   * Whether a copy kept here lasts. `local` is the container's own disk, gone
   * on the next deploy: fine on a developer's machine, never in production.
   */
  durable() {
    return this.providerName() === 'r2' || process.env.NODE_ENV !== 'production';
  }

  async put(storageKey: string, bytes: Buffer, contentType: string) {
    await this.putBuffer(storageKey, bytes, contentType);
  }
}

/** `invoice-files/<office>/<invoice>/<file>`: the console's own ids, so nothing Jobber names reaches a key. */
export const invoiceFileKey = (organizationId: string, invoiceId: string, fileId: string) =>
  `invoice-files/${organizationId}/${invoiceId}/${fileId}`;

/** How a browser opens it: in place where it can, under its own name. */
export function inlineDisposition(fileName: string) {
  const plain = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'file';
  return `inline; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
