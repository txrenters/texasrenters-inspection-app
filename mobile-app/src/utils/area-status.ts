import type { InspectionRoom } from '@/domain/models';

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

  if (room.completionStatus === 'RECORDING_SAVED') {
    const analyzing =
      room.processingStatus !== 'READY_FOR_REVIEW' && room.processingStatus !== 'NOT_STARTED';
    if (analyzing)
      return {
        status: 'PROCESSING',
        label: 'Analyzing',
        detail: 'Uploaded — analysis is running',
        tone: 'progress',
        icon: 'loader',
        needsAttention: false,
      };
    return {
      status: 'READY_TO_COMPLETE',
      label: 'Ready to complete',
      detail: 'Recording saved — review and mark this area complete',
      tone: 'info',
      icon: 'video',
      needsAttention: true,
    };
  }

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
