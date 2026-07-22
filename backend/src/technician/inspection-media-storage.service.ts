import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

import { ApplicationError } from '../common/errors';

const LOCAL_ROOT = resolve(process.cwd(), '.local-inspection-media');

@Injectable()
export class InspectionMediaStorageService {
  async putFromFile(storageKey: string, sourcePath: string, mimeType: string) {
    if (this.provider() === 'supabase') {
      const { error } = await this.bucket().upload(storageKey, await readFile(sourcePath), {
        contentType: mimeType,
        upsert: false,
      });
      if (error)
        throw new ApplicationError(
          502,
          'INSPECTION_MEDIA_STORAGE_FAILED',
          'The room video could not be stored securely.',
        );
      return;
    }
    const path = this.localPath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
  }

  async get(storageKey: string) {
    if (this.provider() === 'supabase') {
      const { data, error } = await this.bucket().download(storageKey);
      if (error || !data)
        throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
      return Buffer.from(await data.arrayBuffer());
    }
    try {
      return await readFile(this.localPath(storageKey));
    } catch {
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');
    }
  }

  async delete(storageKey: string) {
    if (this.provider() === 'supabase') {
      await this.bucket().remove([storageKey]);
      return;
    }
    await rm(this.localPath(storageKey), { force: true });
  }

  private provider() {
    return process.env.INSPECTION_MEDIA_STORAGE_PROVIDER === 'supabase' ? 'supabase' : 'local';
  }

  private bucket() {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey)
      throw new ApplicationError(
        503,
        'INSPECTION_MEDIA_STORAGE_NOT_CONFIGURED',
        'Private inspection-media storage is not configured.',
      );
    const client = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return client.storage.from(process.env.INSPECTION_MEDIA_STORAGE_BUCKET || 'inspection-media');
  }

  private localPath(storageKey: string) {
    const path = resolve(LOCAL_ROOT, storageKey);
    if (path !== LOCAL_ROOT && !path.startsWith(`${LOCAL_ROOT}${sep}`))
      throw new ApplicationError(400, 'INVALID_STORAGE_KEY', 'Invalid inspection-media storage key.');
    return path;
  }
}
