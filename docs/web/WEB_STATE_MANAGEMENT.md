# Web state management

The console uses TanStack Query v5. Query structural sharing runs through
`reconcileServerState`, which preserves pending intent and rejects stale revisions globally.
Mutations use the helpers in `web-app/lib/state-consistency.ts`.

Forms own local drafts. Cache updates must not overwrite a dirty draft. Extracted-area rows track
the revision loaded into the form; if another response changes it, the row shows a conflict and
requires the administrator to resolve it.

Mutation rules:

- cancel affected queries before an optimistic patch;
- snapshot and roll back only the affected entity;
- merge the authoritative REST response before verification;
- never invalidate as the only success action for mutable entities;
- keep delete tombstones;
- replace temporary IDs without duplicating rows;
- scope progress and errors to the affected row/action;
- do not put provider keys, tokens, prompts, or private payloads in logs.

