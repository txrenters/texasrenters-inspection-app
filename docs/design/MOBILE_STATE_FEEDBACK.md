# Mobile state feedback

## Loading

Show the compact branded loader for initial screen acquisition. Use skeletons for expected content
shape. Background polling and realtime reconciliation must not trigger pull-to-refresh visuals or
replace visible data with a loader.

## Search and filters

Filter the latest cached data immediately. Debounce only the REST refresh. Keep the previous result
visible while the newer request is pending, then accept or reject it using the latest-intent-wins
rules.

## Empty

Explain whether the collection is genuinely empty or only has no filter match. Offer the correct
next action; do not tell a user to synchronize Propertyware when a search merely has no match.

## Offline and queued

The user's saved local intent remains visible. Label recording evidence as queued, uploading,
processing, failed, or complete. Offline is a workflow state, not a critical screen error.

## Error

Translate transport failures into a useful message and retry action. Preserve saved work. Do not
show stack traces, localhost URLs, credentials, or raw provider payloads.

## AI

Extracted areas remain drafts until an authorized administrator approves them. AI findings remain
`PENDING_REVIEW`. The UI must never imply that AI approved tenant charges or legal responsibility.

