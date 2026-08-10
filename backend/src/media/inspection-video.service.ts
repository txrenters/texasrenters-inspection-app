import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  InspectionStatus,
  MediaProcessingStatus,
  MediaUploadStatus,
  VideoRecordingType,
} from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { enterTenant, withSystemTenant } from '../database/tenant-context';
import { CloudflareStreamService } from './cloudflare-stream.service';
import { MediaProcessingService } from '../technician/media-processing.service';

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
  /**
   * Cloudflare's `ready` means the encode finished, not that we are done.
   *
   * This used to map to READY, which is the *pipeline's* terminal state — set
   * only after transcription, analysis and inspection advancement. Claiming it
   * here had a precise consequence: `MediaProcessingService.process` opens with
   * `if (media.processingStatus === READY) return`, so every Stream recording
   * was declared finished a moment before the pipeline looked at it, and
   * returned immediately. No transcript, no summary, no findings — which reads
   * as "the AI found nothing" rather than "the AI never ran".
   *
   * PROCESSING is the honest answer: Cloudflare's part is done and ours has not
   * started. Playability is not affected, because that is decided by `readyAt`
   * rather than this column — see `getPlayback`.
   */
  ready: MediaProcessingStatus.PROCESSING,
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
    // Optional so the many tests that construct this service with two mocks
    // keep working, and so a deployment missing the pipeline still accepts
    // webhooks rather than rejecting the delivery Cloudflare will stop retrying.
    @Optional()
    @Inject(MediaProcessingService)
    private readonly mediaProcessing?: MediaProcessingService,
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
    /**
     * Annotated, and that is the point.
     *
     * This filter was written inline inside a conditional spread, which widens
     * the object's type and switches off excess-property checking — so
     * `inspection: { … }`, a relation InspectionMedia does not have, compiled
     * cleanly and failed at runtime for every technician. Naming it with an
     * explicit Prisma type puts the check back: get the relation wrong here and
     * it will not build.
     */
    const assignedToCaller: Prisma.InspectionMediaWhereInput = {
      inspectionArea: {
        inspection: { assignments: { some: { technicianId: user.id, isCurrent: true } } },
      },
    };
    const media = await this.prisma.inspectionMedia.findFirst({
      where: {
        id: videoId,
        organizationId: user.organizationId,
        // Either an administrator with rights over inspections, or the
        // technician this inspection is currently assigned to. Expressed in the
        // query so an unauthorized caller gets a plain not-found and cannot use
        // the endpoint to discover which video ids exist.
        // Administrators see any video in their organization; everyone else
        // only what they are currently assigned.
        ...(user.permissions.includes('inspections:read') ? {} : assignedToCaller),
      },
      select: {
        id: true,
        provider: true,
        streamUid: true,
        storageKey: true,
        processingStatus: true,
        // Whether Cloudflare finished encoding, which is what decides
        // playability here — not our pipeline's processingStatus.
        readyAt: true,
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
        // Playable once the object exists in the bucket, for the same reason
        // the Stream branch keys off readyAt: this endpoint answers "can this be
        // watched", and analysis finishing later must not gate that.
        status: media.storageKey ? ('ready' as const) : ('processing' as const),
        contentPath: media.storageKey ? `/api/v1/admin/media/${media.id}/content` : null,
        durationSeconds: media.durationSeconds,
      };

    /**
     * Playable once Cloudflare has encoded it, which is what `readyAt` records.
     *
     * Deliberately not `processingStatus === READY`. That column tracks our own
     * transcription and analysis, which run *after* the encode and take longer —
     * gating playback on them would hide a perfectly watchable recording from a
     * reviewer for as long as the AI took, and hide it forever if analysis
     * failed. The video and the findings about it become available
     * independently, and this endpoint reports the video.
     */
    // Failure is checked before playability, not after. An encode that failed
    // can still carry a readyAt from an earlier delivery, and reporting that as
    // playable would hand the reviewer a signed URL for a video Cloudflare
    // cannot serve.
    if (media.processingStatus === MediaProcessingStatus.FAILED)
      return {
        videoId: media.id,
        provider: 'cloudflare_stream' as const,
        status: 'failed' as const,
        streamUid: media.streamUid,
        failureMessage: media.failureMessage,
      };

    if (!media.readyAt)
      return {
        videoId: media.id,
        provider: 'cloudflare_stream' as const,
        status: 'processing' as const,
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

    // Cloudflare authenticates with an HMAC signature, not a session, so
    // there is no organization until the uid resolves to a recording. The
    // lookup runs as the system; everything after it is scoped to the
    // organization that recording belongs to.
    const media = await withSystemTenant(() =>
      this.prisma.inspectionMedia.findUnique({
        where: { streamUid },
        // readyAt is what "Cloudflare has finished encoding this" is recorded
        // as, and therefore what decides whether the pipeline still owes work.
        select: {
          id: true,
          processingStatus: true,
          readyAt: true,
          organizationId: true,
          inspectionId: true,
        },
      }),
    );
    // An unknown uid is not an error worth failing on: Cloudflare retries 5xx,
    // and a video deleted on our side would then be retried forever.
    if (!media) {
      this.logger.warn({ event: 'stream_webhook_unknown_video', streamUid });
      return { accepted: false as const, reason: 'UNKNOWN_VIDEO' };
    }

    // The uid resolved, so the organization is known from here on. Narrowing
    // now means the writes this handler makes are tenant-checked rather than
    // running with system access for the rest of the call.
    enterTenant(media.organizationId);

    const state = payload.status?.state ?? 'unknown';
    const processingStatus = STREAM_STATE_TO_PROCESSING[state];
    if (!processingStatus) {
      this.logger.warn({ event: 'stream_webhook_unmapped_state', streamUid, state });
      return { accepted: false as const, reason: 'UNMAPPED_STATE' };
    }

    // Cloudflare's own word for "the encode is finished and this is playable",
    // read from the payload rather than from our column — that column now
    // tracks our pipeline, which has not run yet at this point.
    const encoded = state === 'ready';
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
        ...(encoded && !media.readyAt ? { readyAt: new Date() } : {}),
        ...(failed
          ? {
              failedAt: new Date(),
              failureCode: 'STREAM_ENCODING_FAILED',
              failureMessage: payload.status?.errorReasonText ?? 'Cloudflare could not encode this video.',
            }
          : {}),
      },
    });

    /**
     * Start transcription and analysis, which nothing else does for a Stream
     * recording.
     *
     * The legacy multipart path queues this from the technician controller,
     * because the bytes arrive there. A Stream upload goes device → Cloudflare
     * and never touches this backend, so the webhook is the only moment we
     * learn the video exists and is playable — and it was not queueing. Every
     * recording since the Stream migration reached READY with no transcript, no
     * summary and no findings, which reads as "the AI found nothing" rather
     * than "the AI never ran".
     *
     * Only on the transition into READY. Cloudflare retries deliveries, and
     * re-queueing on each one would transcribe the same video repeatedly at
     * cost.
     */
    if (encoded && !media.readyAt) this.mediaProcessing?.queue(media.id, media.organizationId);

    this.logger.log({
      event: 'stream_webhook_applied',
      mediaId: media.id,
      streamUid,
      state,
      processingStatus,
      queuedProcessing: encoded && !media.readyAt,
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
