# Business Rules

- One video belongs to exactly one organization, property, inspection, approved property area, inspection area, and technician.
- The inspection lifecycle is `MOVE_IN -> OCCUPIED (repeatable) -> BACK_TO_MARKET -> MOVE_OUT` for each property/unit/lease occupancy.
- A completed move-in inspection is the immutable comparison baseline for every later inspection in the same occupancy lifecycle.
- Back-to-market is normally scheduled about 60 days before lease end, but the date remains an operations decision rather than an automatic legal or financial conclusion.
- An approved floor plan and property-area master list are reusable across inspections until an administrator records a property-layout change.
- AI-extracted tags are `DRAFT` until human approval. Duplicate names on one floor are invalid.
- Only assigned technicians can access or upload to an inspection.
- Required areas need a confirmed video or authorized skip reason before completion; optional areas may remain incomplete.
- AI payloads are validated before persistence and findings start `PENDING_REVIEW`.
- Reject and reinspection actions require reasons; sensitive actions create audit events.
- AI never approves responsibility, legal conclusions, deductions, repair expenses, or tenant charges.
