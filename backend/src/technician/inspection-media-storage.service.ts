import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';

import { ObjectStorage } from '../common/object-storage';

const LOCAL_ROOT = resolve(process.cwd(), '.local-inspection-media');

/**
 * Durable storage for room videos and inspection photos. Content-agnostic: the
 * same keys and backends serve both. See {@link ObjectStorage} for the provider
 * switch (`local` | `supabase` | `r2`).
 */
@Injectable()
export class InspectionMediaStorageService extends ObjectStorage {
  constructor() {
    super({
      providerEnv: 'INSPECTION_MEDIA_STORAGE_PROVIDER',
      bucketEnv: 'INSPECTION_MEDIA_STORAGE_BUCKET',
      defaultBucket: 'inspection-media',
      localRoot: LOCAL_ROOT,
      notFoundCode: 'INSPECTION_MEDIA_NOT_FOUND',
      notFoundMessage: 'Room video not found.',
      writeFailedCode: 'INSPECTION_MEDIA_STORAGE_FAILED',
      writeFailedMessage: 'The room video could not be stored securely.',
      notConfiguredCode: 'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
      notConfiguredMessage: 'Private inspection-media storage is not configured.',
      invalidKeyCode: 'INVALID_STORAGE_KEY',
      invalidKeyMessage: 'Invalid inspection-media storage key.',
    });
  }

  /** Uploads spool to a temp file first, so the source is a path, not a Buffer. */
  async putFromFile(storageKey: string, sourcePath: string, mimeType: string) {
    await this.putFile(storageKey, sourcePath, mimeType);
  }

  /** Writes bytes already in memory, e.g. a cached resized photo variant. */
  async putBytes(storageKey: string, bytes: Buffer, mimeType: string) {
    await this.putBuffer(storageKey, bytes, mimeType);
  }
}
