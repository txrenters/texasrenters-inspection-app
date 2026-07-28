# Capture interruption and recovery

- A recording remains local until explicitly discarded.
- Stopping gives the native camera a short grace period to finalize.
- If finalization times out, the camera instance is remounted and the technician is asked to retake.
- Android frame bookmarks are processed only after the video URI is durable.
- A failed frame extraction does not discard the video; the review warns that a separate photo is needed.
- Photo and video uploads use stable idempotency keys and retain recoverable local records.
- App foreground/background upload processing is independent from the room workflow.

No partial raw sensor stream is sent to the backend. A stopped session saves only its summarized
rotation, confidence, evidence counts, and technician confirmation.
