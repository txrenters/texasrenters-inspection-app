import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InspectionStatus,
  MediaProcessingStatus,
  MediaUploadStatus,
  VideoRecordingType,
} from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { CloudflareStreamService } from './cloudflare-stream.service';

/**
 * Limits enforced before Cloudflare is ever contacted.
 *
 * `uploadBytesTotal` is a 4-byte integer column, so the cap also keeps the
 * declared size representable — a value above this would be stored wrong rather
 * than rejected.
 */
const MAX_UPLOAD_BYTES = 2_000_000_000;

/**
 * How long a playback token stays valid.
 *
 * Long enough to watch a walkthrough through a pause and a rewind — an HLS
 * player keeps requesting segments, so a token that dies mid-video looks like a
 * broken recording. Short enough that a leaked URL is not a lasting grant; the
 * client re-requests this endpoint and gets a fresh one.
 */
const PLAYBACK_TTL_SECONDS = 2 * 60 * 60;
const MAX_DURATION_SECONDS = 60 * 30;
const ALLOWED_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);

/**
 * Cloudflare's encoding vocabulary, mapped to ours.
 *
 * `downloading` and `queued` are both "Cloudflare has the bytes and is working
 * on them", which is PROCESSING here. Anything unrecognised is left alone
 * rather than guessed at — a new Cloudflare state must not silently mark
 * evidence ready.
 */
const STREAM_STATE_TO_PROCESSING: Record<string, MediaProcessingStatus> = {
  pendingupload: MediaProcessingStatus.PENDING,
  downloading: MediaProcessingStatus.PROCESSING,
  queued: MediaProcessingStatus.PROCESSING,
  inprogress: MediaProcessingStatus.PROCESSING,
  ready: MediaProcessingStatus.READY,
  error: MediaProcessingStatus.FAILED,
};

export interface UploadSessionInput {
  inspectionAreaId: string;
  recordingType?: VideoRecordingType;
  filename: string;
  mimeType: string;
  fileSize: number;
  durationSeconds: number;
  /** The device queue id, echoed back so a stuck upload can be traced. */
  localQueueId?: string;
  /** Client-generated; makes a retried session request return the same session. */
  idempotencyKey: string;
  recordedAt?: string;
}

@Injectable()
export class InspectionVideoService {
  private readonly logger = new Logger(InspectionVideoService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CloudflareStreamService) private readonly stream: CloudflareStreamService,
  ) {}

  /**
   * Reserve a direct-to-Cloudflare upload for one area recording.
   *
   * The device uploads the bytes itself; this only decides whether it is allowed
   * to, records the intent, and hands back a short-lived URL. No video ever
   * passes through this process.
   */
  async createUploadSession(user: AuthenticatedUser, input: UploadSessionInput) {
    const recordingType = input.recordingType ?? VideoRecordingType.PRIMARY_AREA;
    this.validate(input);

    // Authorization and area lookup in one query: an area only resolves if it
    // belongs to an inspection currently assigned to this technician, inside
    // their own organization. A caller supplying someone else's area id gets a
    // 404, which is also the correct answer — they cannot know it exists.
    const area = await this.prisma.inspectionArea.findFirst({
      where: {
        id: input.inspectionAreaId,
        inspection: {
          organizationId: user.organizationId,
          assignments: { some: { technicianId: user.id, isCurrent: true } },
        },
      },
      select: {
        id: true,
        inspectionId: true,
        inspection: { select: { id: true, status: true, propertyId: true } },
      },
    });
    if (!area)
      throw new ApplicationError(
        404,
        'ASSIGNED_ROOM_NOT_FOUND',
        'Assigned room was not found.',
      );
    if (area.inspection.status !== InspectionStatus.IN_PROGRESS)
      throw new ApplicationError(
        409,
        'INSPECTION_NOT_IN_PROGRESS',
        'Evidence can only be uploaded while the inspection is in progress.',
      );

    // A retried request — a lost response, a double tap, an app relaunch mid
    // queue — must not create a second Cloudflare video. The client's key is
    // stored as providerMediaId, which is unique, so this is also enforced by
    // the database and not only by this read.
    const existing = await this.prisma.inspectionMedia.findUnique({
      where: { providerMediaId: input.idempotencyKey },
      select: { id: true, streamUid: true, uploadStatus: true, inspectionAreaId: true },
    });
    if (existing) {
      if (existing.inspectionAreaId !== area.id)
        throw new ApplicationError(
          409,
          'UPLOAD_KEY_REUSED',
          'That upload key already belongs to a different area.',
        );
      // The Cloudflare URL from the original session may well have expired, so
      // a fresh one is minted against the *same* video record. The device keeps
      // its queue item and its uid; only the URL changes.
      return this.refreshSession(existing.id, existing.streamUid, input);
    }

    const upload = await this.stream.createDirectUpload({
      uploadLengthBytes: input.fileSize,
      maxDurationSeconds: MAX_DURATION_SECONDS,
      metadata: {
        name: input.filename,
        inspectionid: area.inspectionId,
        areaid: area.id,
        technicianid: user.id,
      },
    });

    const media = await this.prisma.inspectionMedia.create({
      data: {
        organizationId: user.organizationId,
        propertyId: area.inspection.propertyId,
        inspectionId: area.inspectionId,
        inspectionAreaId: area.id,
        technicianId: user.id,
        provider: 'cloudflare_stream',
        providerMediaId: input.idempotencyKey,
        // Null: a Stream video has no bucket object. Legacy rows keep theirs.
        storageKey: null,
        streamUid: upload.streamUid,
        mimeType: input.mimeType,
        durationSeconds: input.durationSeconds,
        recordingType,
        originalFilename: input.filename,
        uploadBytesTotal: input.fileSize,
        uploadBytesCompleted: 0,
        localQueueId: input.localQueueId ?? null,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
        uploadStatus: MediaUploadStatus.SESSION_CREATED,
        processingStatus: MediaProcessingStatus.PENDING,
      },
      select: { id: true },
    });

    this.logger.log({
      event: 'stream_upload_session_created',
      mediaId: media.id,
      streamUid: upload.streamUid,
      inspectionId: area.inspectionId,
    });
    return this.sessionResponse(media.id, upload.streamUid, upload.uploadUrl, upload.expiresAt);
  }

  /**
   * Everything a client needs to play one recording, and nothing it does not.
   *
   * Returns a manifest URL the player fetches straight from Cloudflare's edge.
   * Nothing is proxied through this backend — proxying is exactly the round trip
   * that made playback slow, and re-serving segments here would reintroduce it
   * while looking like an improvement.
   *
   * The signed token is minted per request and never stored. A token persisted
   * on the row would outlive its own expiry and become a standing grant to
   * evidence about somebody's home.
   */
  async getPlayback(user: AuthenticatedUser, videoId: string) {
    const media = await this.prisma.inspectionMedia.findFirst({
      where: {
        id: videoId,
        organizationId: user.organizationId,
        // Either an administrator with rights over inspections, or the
        // technician this inspection is currently assigned to. Expressed in the
        // query so an unauthorized caller gets a plain not-found and cannot use
        // the endpoint to discover which video ids exist.
        ...(user.permissions.includes('inspections:read')
          ? {}
          : {
              inspection: {
                assignments: { some: { technicianId: user.id, isCurrent: true } },
              },
            }),
      },
      select: {
        id: true,
        provider: true,
        streamUid: true,
        storageKey: true,
        processingStatus: true,
        uploadStatus: true,
        durationSeconds: true,
        thumbnailUrl: true,
        failureMessage: true,
      },
    });
    if (!media)
      throw new ApplicationError(404, 'INSPECTION_MEDIA_NOT_FOUND', 'Room video not found.');

    // Recorded before the Stream migration. It still plays, through the path it
    // has always used — this endpoint reports that rather than pretending a
    // Stream video exists.
    if (!media.streamUid)
      return {
        videoId: media.id,
        provider: 'legacy' as const,
        status: media.processingStatus === MediaProcessingStatus.READY ? 'ready' : 'processing',
        contentPath: media.storageKey ? `/api/v1/admin/media/${media.id}/content` : null,
        durationSeconds: media.durationSeconds,
      };

    // Not an error: a technician who just finished recording, or a reviewer who
    // opened the area early, should be told to wait rather than shown a failure.
    if (media.processingStatus !== MediaProcessingStatus.READY)
      return {
        videoId: media.id,
        provider: 'cloudflare_stream' as const,
        status:
          media.processingStatus === MediaProcessingStatus.FAILED
            ? ('failed' as const)
            : ('processing' as const),
        streamUid: media.streamUid,
        failureMessage: media.failureMessage,
      };

    const { token, expiresAt } = this.stream.signPlaybackToken(media.streamUid, PLAYBACK_TTL_SECONDS);
    const customer = this.stream.customerCode;
    if (!customer)
      throw new ApplicationError(
        503,
        'STREAM_CUSTOMER_CODE_MISSING',
        'Stream playback is not configured for this environment.',
      );

    // The token stands in for the video id in the path, which is what makes the
    // manifest unreachable without one.
    const base = `https://customer-${customer}.cloudflarestream.com/${token}`;
    return {
      videoId: media.id,
      provider: 'cloudflare_stream' as const,
      status: 'ready' as const,
      streamUid: media.streamUid,
      hlsUrl: `${base}/manifest/video.m3u8`,
      dashUrl: `${base}/manifest/video.mpd`,
      iframeUrl: `${base}/iframe`,
      thumbnailUrl: `${base}/thumbnails/thumbnail.jpg`,
      durationSeconds: media.durationSeconds,
      expiresAt,
    };
  }

  /**
   * Apply a verified Cloudflare notification.
   *
   * Idempotent by construction: the state is derived from the payload rather
   * than advanced by a step, so the same event delivered twice — which
   * Cloudflare will do — lands on the same row values. Signature verification
   * happens in the guard; this trusts its input to be genuinely from Cloudflare
   * but still trusts nothing about *which* video it names.
   */
  async applyWebhook(payload: { uid?: string; status?: { state?: string; errorReasonText?: string | null }; duration?: number | null; input?: { width?: number | null; height?: number | null }; thumbnail?: string | null }) {
    const streamUid = payload.uid;
    if (!streamUid) return { accepted: false as const, reason: 'MISSING_UID' };

    const media = await this.prisma.inspectionMedia.findUnique({
      where: { streamUid },
      select: { id: true, processingStatus: true, organizationId: true, inspectionId: true },
    });
    // An unknown uid is not an error worth failing on: Cloudflare retries 5xx,
    // and a video deleted on our side would then be retried forever.
    if (!media) {
      this.logger.warn({ event: 'stream_webhook_unknown_video', streamUid });
      return { accepted: false as const, reason: 'UNKNOWN_VIDEO' };
    }

    const state = payload.status?.state ?? 'unknown';
    const processingStatus = STREAM_STATE_TO_PROCESSING[state];
    if (!processingStatus) {
      this.logger.warn({ event: 'stream_webhook_unmapped_state', streamUid, state });
      return { accepted: false as const, reason: 'UNMAPPED_STATE' };
    }

    const ready = processingStatus === MediaProcessingStatus.READY;
    const failed = processingStatus === MediaProcessingStatus.FAILED;
    const duration = typeof payload.duration === 'number' && payload.duration > 0
      ? Math.round(payload.duration)
      : undefined;

    await this.prisma.inspectionMedia.update({
      where: { id: media.id },
      data: {
        processingStatus,
        // Cloudflare having the bytes is proof the transfer finished, whatever
        // the device last managed to report before it lost signal.
        ...(state !== 'pendingupload'
          ? { uploadStatus: MediaUploadStatus.UPLOADED, uploadedAt: new Date() }
          : {}),
        ...(duration ? { durationSeconds: duration } : {}),
        ...(payload.input?.width ? { widthPx: payload.input.width } : {}),
        ...(payload.input?.height ? { heightPx: payload.input.height } : {}),
        ...(payload.thumbnail ? { thumbnailUrl: payload.thumbnail } : {}),
        // Stamped once. A repeat delivery must not keep moving readyAt forward,
        // or "when did this become available" stops being answerable.
        ...(ready && media.processingStatus !== MediaProcessingStatus.READY
          ? { readyAt: new Date() }
          : {}),
        ...(failed
          ? {
              failedAt: new Date(),
              failureCode: 'STREAM_ENCODING_FAILED',
              failureMessage: payload.status?.errorReasonText ?? 'Cloudflare could not encode this video.',
            }
          : {}),
      },
    });

    this.logger.log({
      event: 'stream_webhook_applied',
      mediaId: media.id,
      streamUid,
      state,
      processingStatus,
    });
    return { accepted: true as const, mediaId: media.id, processingStatus };
  }

  /**
   * Ask Cloudflare directly about videos that never reported in.
   *
   * A webhook is a single HTTP call to a service that may have been restarting;
   * without this a lost delivery leaves a recording stuck at PROCESSING forever
   * and an inspection that can never be reviewed. Bounded so one run cannot
   * sweep the whole table.
   */
  async reconcileStuckVideos(limit = 25) {
    const stuck = await this.prisma.inspectionMedia.findMany({
      where: {
        provider: 'cloudflare_stream',
        streamUid: { not: null },
        processingStatus: { in: [MediaProcessingStatus.PENDING, MediaProcessingStatus.PROCESSING] },
        // Old enough that a webhook would normally have arrived, so a healthy
        // upload in progress is not polled needlessly.
        createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, streamUid: true },
    });

    let reconciled = 0;
    for (const record of stuck) {
      const video = await this.stream.getVideo(record.streamUid!).catch(() => null);
      if (!video) continue;
      const applied = await this.applyWebhook({
        uid: video.streamUid,
        status: { state: video.state, errorReasonText: video.errorReasonText },
        duration: video.durationSeconds,
        input: { width: video.widthPx, height: video.heightPx },
        thumbnail: video.thumbnailUrl,
      });
      if (applied.accepted) reconciled += 1;
    }
    return { checked: stuck.length, reconciled };
  }

  private async refreshSession(
    mediaId: string,
    streamUid: string | null,
    input: UploadSessionInput,
  ) {
    // No stored uid means the first attempt failed before Cloudflare answered.
    // Nothing exists upstream to resume, so a new video is correct here.
    if (!streamUid) {
      const upload = await this.stream.createDirectUpload({
        uploadLengthBytes: input.fileSize,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        metadata: { name: input.filename },
      });
      await this.prisma.inspectionMedia.update({
        where: { id: mediaId },
        data: { streamUid: upload.streamUid, uploadStatus: MediaUploadStatus.SESSION_CREATED },
      });
      return this.sessionResponse(mediaId, upload.streamUid, upload.uploadUrl, upload.expiresAt);
    }

    // The video already exists at Cloudflare. tus resumption is driven by the
    // upload URL the device still holds, so this returns the record rather than
    // minting a second video for the same recording.
    await this.prisma.inspectionMedia.update({
      where: { id: mediaId },
      data: { retryCount: { increment: 1 } },
    });
    return this.sessionResponse(mediaId, streamUid, null, null);
  }

  private sessionResponse(
    videoId: string,
    streamUid: string,
    uploadUrl: string | null,
    expiresAt: string | null,
  ) {
    return {
      videoId,
      streamUid,
      uploadUrl,
      uploadProtocol: 'tus' as const,
      expiresAt,
      // Cloudflare requires every tus chunk except the last to be a multiple of
      // 256 KiB. These are multiples of it, so a client following them cannot
      // produce a rejected chunk.
      chunkPolicy: { minimumBytes: 5_242_880, preferredBytes: 10_485_760 },
    };
  }

  private validate(input: UploadSessionInput) {
    if (!ALLOWED_MIME_TYPES.has(input.mimeType))
      throw new ApplicationError(
        415,
        'UNSUPPORTED_VIDEO_TYPE',
        'That video format is not supported.',
      );
    if (!Number.isInteger(input.fileSize) || input.fileSize <= 0 || input.fileSize > MAX_UPLOAD_BYTES)
      throw new ApplicationError(413, 'VIDEO_TOO_LARGE', 'That recording is too large to upload.');
    if (
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds > MAX_DURATION_SECONDS
    )
      throw new ApplicationError(
        422,
        'VIDEO_DURATION_INVALID',
        'That recording is longer than an area walkthrough allows.',
      );
  }
}
