# AI Pipeline

Floor-plan and finding providers return structured data that shared Zod schemas validate. Extraction output remains draft. Finding input includes the approved area, timestamped transcript, area baseline, known defects, and allowed enums. The backend rejects unsupported values, invalid timestamps/confidence, and area mismatches.

Floor-plan extraction inspects the complete document, including multi-story plans. Raster plans are sent to supported OpenAI vision models in high-detail mode so small labels and fixture symbols remain readable. The prompt requires a label pass followed by an omission scan; confidently identifiable unlabeled rooms such as bathrooms may be suggested with an explicit `(unlabeled)` suffix, but every suggestion remains a human-reviewed draft. The provider boundary accepts a flat area array or a floor-grouped response, normalizes safe representation differences such as field aliases and boolean strings, removes indistinguishable duplicates, and assigns one global inspection order. The normalized result must still pass the strict shared schema before any draft is persisted.

Re-extraction does not duplicate existing manual or approved areas. The response reports total detected, newly created, and already-present counts so the admin UI does not make skipped duplicates look like model omissions. New draft orders are reserved around existing master-list orders.

Stored AI job metadata includes provider, model ID, prompt version, and schema version. Prompts and full transcripts are excluded from logs. AI findings always begin `PENDING_REVIEW` and cannot create charges.
