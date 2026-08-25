import type { InspectionRoom } from '../domain/models';

/**
 * The state a technician actually needs to see for an area.
 *
 * This is **derived on read**, never stored. The domain has three independent
 * fields — `completionStatus`, `uploadStatus`, `processingStatus` — and the
 * status a technician cares about is a function of all three. Persisting a
 * fourth field would be a second source of truth that drifts the moment an
 * upload finishes in the background.
 */
export type AreaStatus =
  | 'NOT_STARTED'
  | 'RECORDING_SAVED'
  | 'PENDING_UPLOAD'
  | 'UPLOADING'
  | 'UPLOAD_FAILED'
  | 'PROCESSING'
  | 'PROCESSING_FAILED'
  | 'READY_TO_COMPLETE'
  | 'COMPLETED'
  | 'SKIPPED';

export type AreaStatusTone = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

export type AreaStatusDescriptor = {
  status: AreaStatus;
  /** Short label. Never rely on colour alone to convey state. */
  label: string;
  /** One line explaining what, if anything, the technician should do. */
  detail: string;
  tone: AreaStatusTone;
  /** Lucide icon name, resolved by the caller so this module stays UI-free. */
  icon: 'circle' | 'video' | 'cloud-upload' | 'loader' | 'alert-triangle' | 'check' | 'skip';
  /** True when the technician has to act; drives sorting and the up-next pick. */
  needsAttention: boolean;
};

/**
 * Precedence matters and is deliberate:
 *
 *   skipped > completed > failures > in-flight work > saved > not started
 *
 * Failures outrank in-flight states because a stalled upload is the one thing a
 * technician must act on. A finished area is terminal and never re-reports the
 * upload state that got it there.
 */
export function deriveAreaStatus(room: InspectionRoom): AreaStatusDescriptor {
  if (room.completionStatus === 'SKIPPED')
    return {
      status: 'SKIPPED',
      label: 'Skipped',
      detail: room.skipReason ? `Skipped — ${room.skipReason}` : 'Skipped',
      tone: 'neutral',
      icon: 'skip',
      needsAttention: false,
    };

  if (room.completionStatus === 'COMPLETED')
    return {
      status: 'COMPLETED',
      label: 'Completed',
      detail: 'Evidence captured and confirmed',
      tone: 'success',
      icon: 'check',
      needsAttention: false,
    };

  /**
   * The walkthrough is safely off the device, and the technician has not yet
   * confirmed the area.
   *
   * Placed above the in-flight states because it outranks them: the server has
   * told us the bytes arrived, which is a stronger fact than whatever the
   * device's own queue last recorded. This state did not exist before — the
   * server reported UPLOADED and the mapper turned it into NOT_STARTED, so a
   * finished walkthrough read as untouched work.
   */
  // A transitional state the server no longer settles on — the webhook goes
  // straight to COMPLETED — but rows written before that change still carry it,
  // and it means the same thing: the evidence arrived.
  if (room.completionStatus === 'UPLOADED')
    return {
      status: 'COMPLETED',
      label: 'Completed',
      detail: 'Walkthrough uploaded',
      tone: 'success',
      icon: 'check',
      needsAttention: false,
    };

  if (room.completionStatus === 'FAILED')
    return {
      status: 'UPLOAD_FAILED',
      label: 'Failed',
      detail: 'This area could not be processed — record it again',
      tone: 'danger',
      icon: 'alert-triangle',
      needsAttention: true,
    };

  if (room.completionStatus !== 'NOT_STARTED' && room.uploadStatus === 'FAILED')
    return {
      status: 'UPLOAD_FAILED',
      label: 'Upload failed',
      detail: 'Tap to retry — the recording is still safe on this device',
      tone: 'danger',
      icon: 'alert-triangle',
      needsAttention: true,
    };

  if (room.processingStatus === 'FAILED')
    return {
      status: 'PROCESSING_FAILED',
      label: 'Processing failed',
      detail: 'The upload arrived but could not be analyzed',
      tone: 'danger',
      icon: 'alert-triangle',
      needsAttention: true,
    };

  // Upload state only means something once a recording exists. Without this
  // guard an untouched area reports "Waiting to upload", because rooms carry a
  // default uploadStatus of PENDING before anything has been captured.
  const hasRecording = room.completionStatus === 'RECORDING_SAVED';

  if (hasRecording && room.uploadStatus === 'UPLOADING')
    return {
      status: 'UPLOADING',
      label: 'Uploading',
      detail: 'Sending the recording — you can keep inspecting',
      tone: 'progress',
      icon: 'cloud-upload',
      needsAttention: false,
    };

  // PAUSED counts as pending: it resumes on its own when connectivity returns.
  if (hasRecording && (room.uploadStatus === 'PENDING' || room.uploadStatus === 'PAUSED'))
    return {
      status: 'PENDING_UPLOAD',
      label: 'Waiting to upload',
      detail: 'Queued — uploads resume automatically',
      tone: 'info',
      icon: 'cloud-upload',
      needsAttention: false,
    };

  /**
   * The walkthrough is submitted and on its way.
   *
   * Not an action for the technician: the queue delivers it and the area
   * completes itself when Cloudflare confirms the bytes. This used to say
   * "Ready to complete — review and mark this area complete", which described a
   * button that no longer exists and made a finished walkthrough look like
   * outstanding work.
   */
  if (room.completionStatus === 'RECORDING_SAVED')
    return {
      status: 'PENDING_UPLOAD',
      label: 'Upload queued',
      detail: 'Submitted — this area completes once the upload finishes',
      tone: 'info',
      icon: 'cloud-upload',
      needsAttention: false,
    };

  return {
    status: 'NOT_STARTED',
    label: 'Not started',
    detail: room.isRequired ? 'Required — not yet recorded' : 'Optional — not yet recorded',
    tone: 'neutral',
    icon: 'circle',
    needsAttention: room.isRequired,
  };
}

/** Label for the one contextual action an area offers in its current state. */
export function areaActionLabel(status: AreaStatus): string {
  switch (status) {
    case 'NOT_STARTED':
      return 'Start area';
    case 'READY_TO_COMPLETE':
      return 'Review evidence';
    case 'UPLOAD_FAILED':
    case 'PROCESSING_FAILED':
      return 'Resolve issue';
    case 'COMPLETED':
    case 'SKIPPED':
      return 'View area';
    default:
      return 'Continue area';
  }
}

/**
 * The single area to surface as "Up next".
 *
 * Required work outranks optional, and within each the lowest `order` wins so
 * the technician walks the property in the intended sequence. Returns undefined
 * when nothing is outstanding — the caller should then offer submission instead.
 */
export function pickUpNextArea(rooms: readonly InspectionRoom[]): InspectionRoom | undefined {
  const outstanding = rooms.filter((room) => {
    const { status } = deriveAreaStatus(room);
    return status !== 'COMPLETED' && status !== 'SKIPPED';
  });
  if (!outstanding.length) return undefined;

  // A blocked area outranks merely-unstarted work: a failed upload is
  // time-sensitive and can strand evidence, whereas an area not yet recorded is
  // simply the next job. Within a rank, walk the property in sequence.
  const rank = (room: InspectionRoom) => {
    const { status } = deriveAreaStatus(room);
    if (status === 'UPLOAD_FAILED' || status === 'PROCESSING_FAILED') return 0;
    if (status === 'READY_TO_COMPLETE') return 1;
    if (room.isRequired) return 2;
    return 3;
  };
  return [...outstanding].sort((a, b) => rank(a) - rank(b) || a.order - b.order)[0];
}

/**
 * How much of an area's story there is to tell yet.
 *
 * Coarser than `AreaStatus` on purpose. Ten statuses answer "what is happening
 * to this area"; three stages answer "what should the technician be reading",
 * which is the only question the area screen asks. Filming instructions matter
 * before there is a recording and are noise afterwards; evidence and findings
 * are the reverse.
 *
 * Takes the derived status rather than the room, so a screen that already
 * called `deriveAreaStatus` does not derive it twice — and so `UPLOADED`, which
 * that function folds into `COMPLETED`, cannot be treated as unfinished here
 * while the submission gate treats it as finished.
 */
export type AreaStage = 'NOT_FILMED' | 'FILMED' | 'FINISHED';

export function areaStage(status: AreaStatus, hasRecording: boolean): AreaStage {
  // Terminal first: a skipped area has no recording and must still never be
  // offered the filming guidance, and a completed one is not "in progress"
  // because its media is still listed.
  if (status === 'COMPLETED' || status === 'SKIPPED') return 'FINISHED';
  return hasRecording ? 'FILMED' : 'NOT_FILMED';
}
