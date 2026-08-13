import {
  AlertTriangleIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  LoaderIcon,
  XIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';

import { Badge } from './ui/badge';

/**
 * The single mapping from a domain status to its presentation.
 *
 * Every status in the application resolves here, so "APPROVED" cannot look like
 * one thing on the findings table and another on the charge report. Adding a
 * status means adding a row here, not styling a badge inline.
 *
 * Tone never travels alone: each entry carries a readable label and an icon, so
 * the meaning survives greyscale, colour-blindness and a screen reader.
 */
type Tone = 'default' | 'success' | 'warning' | 'destructive' | 'muted';

/**
 * Tones are tinted, never solid.
 *
 * `default` maps to the tinted `info` rather than the solid `default` badge:
 * a status column is read by scanning down it, and forty saturated blue chips
 * make the table itself look like the alert.
 */
const TONE_VARIANT: Record<Tone, ComponentProps<typeof Badge>['variant']> = {
  default: 'info',
  success: 'success',
  warning: 'warning',
  destructive: 'destructive',
  muted: 'secondary',
};

const ICONS = {
  success: CheckIcon,
  warning: AlertTriangleIcon,
  destructive: XIcon,
  processing: LoaderIcon,
  pending: ClockIcon,
  idle: CircleDashedIcon,
} as const;

type Glyph = keyof typeof ICONS;

const STATUS: Record<string, { label: string; tone: Tone; glyph: Glyph }> = {
  // Inspection lifecycle
  SCHEDULED: { label: 'Scheduled', tone: 'default', glyph: 'pending' },
  IN_PROGRESS: { label: 'In progress', tone: 'default', glyph: 'processing' },
  TECHNICIAN_SUBMITTED: { label: 'Submitted', tone: 'default', glyph: 'pending' },
  PROCESSING: { label: 'Processing', tone: 'default', glyph: 'processing' },
  REVIEW_REQUIRED: { label: 'Review required', tone: 'warning', glyph: 'warning' },
  UNDER_REVIEW: { label: 'Under review', tone: 'warning', glyph: 'pending' },
  TBD: { label: 'To be determined', tone: 'muted', glyph: 'idle' },
  FOLLOW_UP_REQUIRED: { label: 'Follow-up required', tone: 'destructive', glyph: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success', glyph: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'muted', glyph: 'destructive' },

  // Area evidence review
  NOT_STARTED: { label: 'Not started', tone: 'muted', glyph: 'idle' },
  SKIPPED: { label: 'Skipped', tone: 'muted', glyph: 'pending' },
  EVIDENCE_INCOMPLETE: { label: 'Evidence incomplete', tone: 'warning', glyph: 'warning' },
  EVIDENCE_READY: { label: 'Evidence ready', tone: 'success', glyph: 'success' },
  ANALYSIS_PROCESSING: { label: 'Analysing', tone: 'default', glyph: 'processing' },
  FINDINGS_NEED_REVIEW: { label: 'Findings need review', tone: 'warning', glyph: 'warning' },
  REVIEWED: { label: 'Reviewed', tone: 'success', glyph: 'success' },

  // Media
  PENDING: { label: 'Pending', tone: 'muted', glyph: 'pending' },
  UPLOADING: { label: 'Uploading', tone: 'default', glyph: 'processing' },
  UPLOADED: { label: 'Uploaded', tone: 'success', glyph: 'success' },
  READY: { label: 'Ready', tone: 'success', glyph: 'success' },
  FAILED: { label: 'Failed', tone: 'destructive', glyph: 'destructive' },

  // Review decisions. Findings and estimates are deliberately separate axes —
  // a valid finding may still have an unapproved amount.
  PENDING_REVIEW: { label: 'Needs review', tone: 'warning', glyph: 'pending' },
  APPROVED: { label: 'Approved', tone: 'success', glyph: 'success' },
  EDITED: { label: 'Edited', tone: 'default', glyph: 'success' },
  REJECTED: { label: 'Rejected', tone: 'destructive', glyph: 'destructive' },
  REINSPECTION_REQUESTED: { label: 'Re-inspection', tone: 'warning', glyph: 'warning' },
  DRAFT: { label: 'Draft', tone: 'muted', glyph: 'idle' },
  ADJUSTED: { label: 'Adjusted', tone: 'default', glyph: 'success' },
  WAIVED: { label: 'Waived', tone: 'muted', glyph: 'idle' },

  // Severity
  LOW: { label: 'Low', tone: 'muted', glyph: 'idle' },
  MEDIUM: { label: 'Medium', tone: 'warning', glyph: 'warning' },
  HIGH: { label: 'High', tone: 'destructive', glyph: 'warning' },

  // Assignment
  ASSIGNED: { label: 'Assigned', tone: 'success', glyph: 'success' },
  UNASSIGNED: { label: 'Unassigned', tone: 'warning', glyph: 'warning' },

  // Accounts and sync
  ACTIVE: { label: 'Active', tone: 'success', glyph: 'success' },
  INACTIVE: { label: 'Inactive', tone: 'muted', glyph: 'idle' },
  CURRENT: { label: 'Current', tone: 'success', glyph: 'success' },
  RUNNING: { label: 'Running', tone: 'default', glyph: 'processing' },
  COMPLETED_WITH_ERRORS: { label: 'Completed with errors', tone: 'warning', glyph: 'warning' },
  QUEUED: { label: 'Queued', tone: 'muted', glyph: 'pending' },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warning', glyph: 'warning' },
};

/** Readable fallback for a status not yet mapped, rather than a raw enum. */
function fallback(value: string) {
  return {
    label: value
      .replaceAll('_', ' ')
      .toLowerCase()
      .replace(/^./, (character) => character.toUpperCase()),
    tone: 'default' as Tone,
    glyph: 'idle' as Glyph,
  };
}

export function StatusBadge({
  value,
  showIcon = true,
  className,
  ...props
}: { value: string; showIcon?: boolean } & Omit<ComponentProps<typeof Badge>, 'variant'>) {
  const meta = STATUS[value] ?? fallback(value);
  const Icon = ICONS[meta.glyph];
  return (
    <Badge variant={TONE_VARIANT[meta.tone]} className={className} {...props}>
      {showIcon ? (
        <Icon
          aria-hidden
          className={meta.glyph === 'processing' ? 'motion-safe:animate-spin' : undefined}
        />
      ) : null}
      {meta.label}
    </Badge>
  );
}

/** Exposed so tests and docs can assert the mapping is complete. */
export const STATUS_MAP = STATUS;
