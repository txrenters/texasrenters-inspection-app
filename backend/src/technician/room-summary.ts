/**
 * Marker for the informational per-room AI summary. Summaries are context for
 * reviewers, not chargeable findings: queries exclude them from the review
 * queue and from every pending-review count/gate.
 *
 * In a file of its own so the visual review can read it without importing the
 * pipeline that imports the visual review.
 */
export const ROOM_SUMMARY_TITLE = 'Room condition summary';

/** Prisma where-fragment matching summary rows. */
export const ROOM_SUMMARY_WHERE = { findingType: 'NO_CHANGE', title: ROOM_SUMMARY_TITLE } as const;
