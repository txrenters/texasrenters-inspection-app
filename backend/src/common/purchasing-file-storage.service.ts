import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';

import { ObjectStorage, type StorageProvider } from './object-storage';

const LOCAL_ROOT = resolve(process.cwd(), '.local-purchasing-files');

/** Where the inspection media is kept, which purchasing files follow unless told otherwise. */
const MEDIA_PROVIDER_ENV = 'INSPECTION_MEDIA_STORAGE_PROVIDER';
const MEDIA_BUCKET_DEFAULT = 'inspection-media';

/**
 * The files attached to purchase requisitions (2026-11-20, part 3 of the
 * NAV-style requisition): quotes, pictures, lists.
 *
 * Kept where the inspection photos and invoice files are -- the same private
 * bucket and provider, under `purchasing-files/` -- so production needs
 * nothing new to set up; `PURCHASING_FILE_STORAGE_PROVIDER` and
 * `PURCHASING_FILE_STORAGE_BUCKET` put them elsewhere. Opened only through
 * short-lived signed links.
 */
@Injectable()
export class PurchasingFileStorageService extends ObjectStorage {
  constructor() {
    super({
      providerEnv: 'PURCHASING_FILE_STORAGE_PROVIDER',
      bucketEnv: 'PURCHASING_FILE_STORAGE_BUCKET',
      defaultBucket: process.env.INSPECTION_MEDIA_STORAGE_BUCKET || MEDIA_BUCKET_DEFAULT,
      localRoot: LOCAL_ROOT,
      notFoundCode: 'REQUISITION_FILE_NOT_FOUND',
      notFoundMessage: 'That file was not found.',
      writeFailedCode: 'REQUISITION_FILE_STORAGE_FAILED',
      writeFailedMessage: 'The file could not be stored. Try again.',
      notConfiguredCode: 'REQUISITION_FILE_STORAGE_NOT_CONFIGURED',
      notConfiguredMessage: 'Private file storage is not configured.',
      invalidKeyCode: 'INVALID_STORAGE_KEY',
      invalidKeyMessage: 'Invalid purchasing file storage key.',
    });
  }

  /** The purchasing files' own provider when one is named, else the inspection media's. */
  override providerName(): StorageProvider {
    const value = process.env.PURCHASING_FILE_STORAGE_PROVIDER?.trim() || process.env[MEDIA_PROVIDER_ENV];
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

/** `purchasing-files/<office>/<requisition>/<file>`: the console's own ids, so nothing a person typed reaches a key. */
export const requisitionFileKey = (organizationId: string, requisitionId: string, fileId: string) =>
  `purchasing-files/${organizationId}/${requisitionId}/${fileId}`;
