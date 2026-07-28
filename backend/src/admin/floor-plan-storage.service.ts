import { resolve } from 'node:path';

import { Injectable } from '@nestjs/common';

import { ObjectStorage } from '../common/object-storage';

const LOCAL_ROOT = resolve(process.cwd(), '.local-floor-plans');

/**
 * Durable storage for uploaded floor-plan images and PDFs. See
 * {@link ObjectStorage} for the provider switch (`local` | `supabase` | `r2`).
 */
@Injectable()
export class FloorPlanStorageService extends ObjectStorage {
  constructor() {
    super({
      providerEnv: 'FLOOR_PLAN_STORAGE_PROVIDER',
      bucketEnv: 'FLOOR_PLAN_STORAGE_BUCKET',
      defaultBucket: 'floor-plans',
      localRoot: LOCAL_ROOT,
      notFoundCode: 'FLOOR_PLAN_NOT_FOUND',
      notFoundMessage: 'Floor plan was not found.',
      writeFailedCode: 'FLOOR_PLAN_STORAGE_FAILED',
      writeFailedMessage: 'The floor plan could not be stored securely.',
      notConfiguredCode: 'FLOOR_PLAN_STORAGE_NOT_CONFIGURED',
      notConfiguredMessage: 'Private floor-plan storage is not configured.',
      invalidKeyCode: 'INVALID_STORAGE_KEY',
      invalidKeyMessage: 'Invalid floor-plan storage key.',
    });
  }

  async put(storageKey: string, bytes: Buffer, mimeType: string) {
    await this.putBuffer(storageKey, bytes, mimeType);
  }
}
