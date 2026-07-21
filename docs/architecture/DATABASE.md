# Database

Prisma models organizations, users/memberships, properties, reusable floor plans/extraction, floors/areas, area-specific baselines, inspections/assignments/areas/status history, room-bound media/upload sessions/events, transcription segments, versioned AI jobs/findings/reviews, audit logs, and unique webhook events.

`Inspection.inspectionType` records the four-stage lifecycle. Later lifecycle inspections store `baselineInspectionId`, a self-relation to the completed move-in inspection for the same organization, property, unit, and lease. The relationship is selected at creation and is never inferred from a mutable "latest inspection" lookup.

UUID primary keys and UTC timestamps are used throughout. Important uniqueness constraints cover organization roles, property/floor room names, one property area per inspection, provider media IDs, idempotency keys, and provider webhook IDs. Indexes support assignments, room order, processing jobs, finding review, audit lookup, and media lookup.
