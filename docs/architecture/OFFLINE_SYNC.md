# Offline Synchronization

## Current device behavior

Zustand persists local workflow metadata through SQLite on native devices. Persisted data includes room changes, notes, durable local-media metadata, queue items, upload failures, retry checkpoints, simulation settings, and finding decisions. Supabase access and refresh tokens remain in the device keychain or keystore rather than SQLite.

Validated, user-scoped REST DTOs for the authenticated profile, assigned inspections, inspection context, properties, and approved rooms are cached in SQLite. Only connection or server-availability failures may use that cache; authorization, assignment, and business-rule responses from the backend always win.

Saving a recording persists the video in app document storage, records its metadata, creates an idempotent queue entry bound to one inspection area, and immediately advances the technician to the next unfinished approved room. The queue is mounted above every authenticated screen rather than being owned by the Uploads tab.

The foreground runner retries connection and 5xx failures with bounded exponential backoff and resumes interrupted entries when the app becomes active. It waits for backend confirmation, then retains the local recording as recoverable evidence. Never delete a local video solely because bytes were transferred.

Server authorization and approved-area state win conflicts, while device media remains recoverable. Native OS-level upload while the app is suspended or terminated is intentionally deferred; queued work resumes automatically when the app returns to the foreground.

## Demo behavior

Demo Mode uses the same repository and persisted-queue boundary with simulated transfer and processing stages. Offline simulation leaves media pending and accessible. Reset Demo Data clears persisted demo state only after destructive confirmation.
