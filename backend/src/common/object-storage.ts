import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { ApplicationError } from './errors';

export type StorageProvider = 'local' | 'supabase' | 'r2';

/**
 * Poster-frame key for a video object. Derived rather than stored: a thumbnail is
 * regenerable from its video, so it needs no database column and can never drift
 * out of sync with one.
 */
export function thumbnailKeyFor(videoStorageKey: string) {
  return `${videoStorageKey}.thumb.jpg`;
}

/**
 * Derived key for a width-limited copy of a photo, following the same rule as
 * video posters: regenerable data gets a derived key, never a column.
 */
export function resizedPhotoKeyFor(photoStorageKey: string, width: number) {
  return `${photoStorageKey}.w${width}.jpg`;
}

export interface ObjectStorageConfig {
  /** Env var naming the active provider, e.g. INSPECTION_MEDIA_STORAGE_PROVIDER. */
  providerEnv: string;
  bucketEnv: string;
  defaultBucket: string;
  /** Directory used by the `local` provider (development only). */
  localRoot: string;
  notFoundCode: string;
  notFoundMessage: string;
  writeFailedCode: string;
  writeFailedMessage: string;
  notConfiguredCode: string;
  notConfiguredMessage: string;
  invalidKeyCode: string;
  invalidKeyMessage: string;
}

// Clients are cached per credential set: constructing one per request wasted a
// TLS handshake on every upload and download.
const supabaseClients = new Map<string, SupabaseClient>();
const s3Clients = new Map<string, S3Client>();

/**
 * Object storage with three interchangeable backends.
 *
 * `local` writes to the container's disk and is development-only — that disk is
 * ephemeral, so anything stored there is lost on redeploy. `supabase` and `r2`
 * are durable. Storage keys are identical across backends, so migrating between
 * them never requires touching the database.
 */
export abstract class ObjectStorage {
  protected constructor(private readonly config: ObjectStorageConfig) {}

  /** The active backend, recorded on media rows as their `provider`. */
  providerName(): StorageProvider {
    const value = process.env[this.config.providerEnv];
    return value === 'supabase' || value === 'r2' ? value : 'local';
  }

  async get(storageKey: string): Promise<Buffer> {
    const provider = this.providerName();
    if (provider === 'r2') {
      try {
        const response = await this.s3().send(
          new GetObjectCommand({ Bucket: this.bucketName(), Key: storageKey }),
        );
        const bytes = await response.Body?.transformToByteArray();
        if (!bytes) throw new Error('empty body');
        return Buffer.from(bytes);
      } catch {
        throw this.notFound();
      }
    }
    if (provider === 'supabase') {
      const { data, error } = await this.supabaseBucket().download(storageKey);
      if (error || !data) throw this.notFound();
      return Buffer.from(await data.arrayBuffer());
    }
    try {
      return await readFile(this.localPath(storageKey));
    } catch {
      throw this.notFound();
    }
  }

  async delete(storageKey: string) {
    const provider = this.providerName();
    if (provider === 'r2') {
      await this.s3().send(
        new DeleteObjectCommand({ Bucket: this.bucketName(), Key: storageKey }),
      );
      return;
    }
    if (provider === 'supabase') {
      await this.supabaseBucket().remove([storageKey]);
      return;
    }
    await rm(this.localPath(storageKey), { force: true });
  }

  /**
   * A short-lived URL the browser can fetch directly, bypassing the API. Returns
   * null for `local`, where callers must fall back to proxying bytes.
   */
  async signedUrl(storageKey: string, expiresInSeconds = 900): Promise<string | null> {
    const provider = this.providerName();
    if (provider === 'r2') {
      return getSignedUrl(
        this.s3(),
        new GetObjectCommand({ Bucket: this.bucketName(), Key: storageKey }),
        { expiresIn: expiresInSeconds },
      );
    }
    if (provider === 'supabase') {
      const { data, error } = await this.supabaseBucket().createSignedUrl(
        storageKey,
        expiresInSeconds,
      );
      if (error || !data?.signedUrl) return null;
      return data.signedUrl;
    }
    return null;
  }

  protected async putBuffer(storageKey: string, bytes: Buffer, mimeType: string) {
    const provider = this.providerName();
    if (provider === 'r2') {
      try {
        await this.s3().send(
          new PutObjectCommand({
            Bucket: this.bucketName(),
            Key: storageKey,
            Body: bytes,
            ContentType: mimeType,
          }),
        );
      } catch {
        throw this.writeFailed();
      }
      return;
    }
    if (provider === 'supabase') {
      const { error } = await this.supabaseBucket().upload(storageKey, bytes, {
        contentType: mimeType,
        upsert: false,
      });
      if (error) throw this.writeFailed();
      return;
    }
    const path = this.localPath(storageKey);
    await mkdir(dirname(path), { recursive: true });
    // `wx` so a key collision fails loudly instead of silently overwriting.
    await writeFile(path, bytes, { flag: 'wx' });
  }

  protected async putFile(storageKey: string, sourcePath: string, mimeType: string) {
    if (this.providerName() === 'local') {
      const path = this.localPath(storageKey);
      await mkdir(dirname(path), { recursive: true });
      await copyFile(sourcePath, path);
      return;
    }
    // Remote backends need the bytes; videos are spooled to a temp file first.
    await this.putBuffer(storageKey, await readFile(sourcePath), mimeType);
  }

  private bucketName() {
    return process.env[this.config.bucketEnv] || this.config.defaultBucket;
  }

  private s3() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) throw this.notConfigured();
    const cacheKey = `${accountId}:${accessKeyId}`;
    const cached = s3Clients.get(cacheKey);
    if (cached) return cached;
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
    s3Clients.set(cacheKey, client);
    return client;
  }

  private supabaseBucket() {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) throw this.notConfigured();
    const cacheKey = `${url}:${serviceRoleKey.slice(-8)}`;
    let client = supabaseClients.get(cacheKey);
    if (!client) {
      client = createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      supabaseClients.set(cacheKey, client);
    }
    return client.storage.from(this.bucketName());
  }

  private localPath(storageKey: string) {
    const root = this.config.localRoot;
    const path = resolve(root, storageKey);
    if (path !== root && !path.startsWith(`${root}${sep}`))
      throw new ApplicationError(400, this.config.invalidKeyCode, this.config.invalidKeyMessage);
    return path;
  }

  private notFound() {
    return new ApplicationError(404, this.config.notFoundCode, this.config.notFoundMessage);
  }

  private writeFailed() {
    return new ApplicationError(502, this.config.writeFailedCode, this.config.writeFailedMessage);
  }

  private notConfigured() {
    return new ApplicationError(
      503,
      this.config.notConfiguredCode,
      this.config.notConfiguredMessage,
    );
  }
}
