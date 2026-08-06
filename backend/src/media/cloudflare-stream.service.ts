import { createSign } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { ApplicationError } from '../common/errors';

/**
 * Everything that talks to Cloudflare Stream, and the only place that holds its
 * credentials.
 *
 * Isolated behind one class for two reasons. It is the seam the tests mock —
 * nothing else in the codebase should need a live Cloudflare account to run —
 * and it keeps the API token in a single file, so "does this leak?" is a
 * question with one place to look rather than a search across the backend.
 *
 * Bytes never pass through here. This service asks Cloudflare for a one-time
 * upload URL and hands it to the device; the video itself goes device → Stream.
 */

const API_ROOT = 'https://api.cloudflare.com/client/v4';

/** Cloudflare returns the video id in this response header on a tus create. */
const STREAM_UID_HEADER = 'stream-media-id';

export interface StreamDirectUpload {
  streamUid: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface StreamVideoState {
  streamUid: string;
  /** Cloudflare's own vocabulary: pendingupload | downloading | queued | inprogress | ready | error */
  state: string;
  durationSeconds: number | null;
  widthPx: number | null;
  heightPx: number | null;
  thumbnailUrl: string | null;
  errorReasonText: string | null;
}

@Injectable()
export class CloudflareStreamService {
  private readonly logger = new Logger(CloudflareStreamService.name);

  /**
   * Whether Stream is usable at all.
   *
   * Checked rather than assumed so the backend still boots, and every other
   * feature still works, on a machine with no Cloudflare credentials. Callers
   * turn a false here into a clear 503 instead of a stack trace about undefined.
   */
  get configured() {
    return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_STREAM_API_TOKEN);
  }

  get signingConfigured() {
    return Boolean(
      process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID && process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM,
    );
  }

  get customerCode() {
    return process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE ?? null;
  }

  /**
   * Reserve a one-time tus upload URL the device can send bytes to.
   *
   * `maxDurationSeconds` is a hard cap Cloudflare enforces on its side, so a
   * client that lies about duration in the session request still cannot store an
   * unbounded video. `requireSignedURLs` makes the result unplayable without a
   * token minted by this backend.
   */
  async createDirectUpload(input: {
    uploadLengthBytes: number;
    maxDurationSeconds: number;
    metadata: Record<string, string>;
  }): Promise<StreamDirectUpload> {
    this.assertConfigured();
    const response = await this.fetchStream(
      `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream?direct_user=true`,
      {
        method: 'POST',
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(input.uploadLengthBytes),
          // Cloudflare reads its own settings out of this header, alongside our
          // correlation ids. Values are base64 per the tus spec.
          'Upload-Metadata': encodeUploadMetadata({
            requiresignedurls: '',
            maxdurationseconds: String(input.maxDurationSeconds),
            ...input.metadata,
          }),
        },
      },
    );

    const uploadUrl = response.headers.get('location');
    // The documented identifier, taken from the header Cloudflare provides
    // rather than scraped out of the upload URL — that URL's shape is not a
    // contract and parsing it would break silently the day it changes.
    const streamUid = response.headers.get(STREAM_UID_HEADER);
    if (!uploadUrl || !streamUid)
      throw new ApplicationError(
        502,
        'STREAM_UPLOAD_SESSION_FAILED',
        'Cloudflare Stream did not return an upload location.',
      );

    return {
      streamUid,
      uploadUrl,
      // Cloudflare expires a direct upload URL after 60 minutes. Reported to the
      // client so the queue can ask for a replacement rather than discovering it
      // by failing a chunk.
      expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
    };
  }

  /**
   * The provider's current view of a video.
   *
   * Used by the reconciliation path when a webhook never arrives, so a video is
   * never stuck "processing" forever because one HTTP callback was lost.
   */
  async getVideo(streamUid: string): Promise<StreamVideoState | null> {
    this.assertConfigured();
    const response = await this.fetchStream(
      `/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/stream/${encodeURIComponent(streamUid)}`,
      { method: 'GET' },
      // A deleted or unknown video is a normal answer here, not a fault.
      [404],
    );
    if (response.status === 404) return null;
    const body = (await response.json()) as { result?: CloudflareVideo };
    return body.result ? normalizeVideo(body.result) : null;
  }

  /**
   * A short-lived signed playback token.
   *
   * Signed locally with the account's RSA key rather than by asking Cloudflare
   * for a token per request: it costs no round trip on a page that may show many
   * videos, and the key never leaves this process. The token is returned to the
   * client and never stored — a persisted one would outlive its own expiry and
   * become a permanent grant sitting in the database.
   */
  signPlaybackToken(streamUid: string, ttlSeconds: number): { token: string; expiresAt: string } {
    if (!this.signingConfigured)
      throw new ApplicationError(
        503,
        'STREAM_SIGNING_NOT_CONFIGURED',
        'Signed playback is not configured for this environment.',
      );
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const header = { alg: 'RS256', kid: process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID };
    const payload = { sub: streamUid, kid: header.kid, exp: expiry, accessRules: [] };

    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(decodeSigningKey(process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM!));

    return {
      token: `${signingInput}.${signature.toString('base64url')}`,
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
  }

  private assertConfigured() {
    if (!this.configured)
      throw new ApplicationError(
        503,
        'STREAM_NOT_CONFIGURED',
        'Video upload is not configured for this environment.',
      );
  }

  private async fetchStream(path: string, init: RequestInit, tolerate: number[] = []) {
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${process.env.CLOUDFLARE_STREAM_API_TOKEN}`,
        },
      });
    } catch {
      // Never include the request headers in this: they carry the API token.
      this.logger.error({ event: 'stream_request_failed', path });
      throw new ApplicationError(
        502,
        'STREAM_UNREACHABLE',
        'Cloudflare Stream could not be reached.',
      );
    }
    if (!response.ok && !tolerate.includes(response.status)) {
      const detail = await response.text().catch(() => '');
      this.logger.error({
        event: 'stream_request_rejected',
        path,
        status: response.status,
        // Cloudflare's error body names the failing field and never echoes the
        // credential, so it is safe to log and is the only clue on a 4xx.
        detail: detail.slice(0, 500),
      });
      throw new ApplicationError(
        502,
        'STREAM_REQUEST_FAILED',
        'Cloudflare Stream rejected the request.',
      );
    }
    return response;
  }
}

interface CloudflareVideo {
  uid: string;
  status?: { state?: string; errorReasonText?: string | null };
  duration?: number | null;
  input?: { width?: number | null; height?: number | null };
  thumbnail?: string | null;
}

function normalizeVideo(video: CloudflareVideo): StreamVideoState {
  return {
    streamUid: video.uid,
    state: video.status?.state ?? 'unknown',
    // Cloudflare reports -1 for a duration it has not determined yet.
    durationSeconds:
      typeof video.duration === 'number' && video.duration >= 0 ? Math.round(video.duration) : null,
    widthPx: video.input?.width ?? null,
    heightPx: video.input?.height ?? null,
    thumbnailUrl: video.thumbnail ?? null,
    errorReasonText: video.status?.errorReasonText ?? null,
  };
}

/** tus `Upload-Metadata`: comma-separated `key base64(value)` pairs. */
function encodeUploadMetadata(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) =>
      // A valueless key is legal tus and is how Cloudflare expects boolean
      // flags such as requiresignedurls.
      value === '' ? key : `${key} ${Buffer.from(value).toString('base64')}`,
    )
    .join(',');
}

function base64Url(value: string) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Accepts the key as PEM or as base64-wrapped PEM.
 *
 * Cloudflare hands the signing key over base64-encoded, and it is also the form
 * that survives an environment variable without newline mangling — a raw PEM
 * pasted into a `.env` loses its line breaks and fails to parse with an error
 * that says nothing useful.
 */
function decodeSigningKey(value: string) {
  if (value.includes('-----BEGIN')) return value;
  return Buffer.from(value, 'base64').toString('utf8');
}
