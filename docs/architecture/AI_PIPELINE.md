# AI Pipeline

Floor-plan and finding providers return structured data that shared Zod schemas validate. Extraction output remains draft. Finding input includes the approved area, timestamped transcript, area baseline, known defects, and allowed enums. The backend rejects unsupported values, invalid timestamps/confidence, and area mismatches.

Stored AI job metadata includes provider, model ID, prompt version, and schema version. Prompts and full transcripts are excluded from logs. AI findings always begin `PENDING_REVIEW` and cannot create charges.
