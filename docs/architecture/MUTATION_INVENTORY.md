# Mutation inventory

Inventory date: 2026-07-28. TanStack Query mutation hooks found: **48 web** and **21 mobile**
(**69 total**). The strategy column describes the intended-state implementation; all successful
server-backed mutations patch an authoritative response before scoped verification unless noted.

## Web console (48)

| Mutations | Endpoint family | Entities / keys | Strategy, rollback, version and offline |
|---|---|---|---|
| test mail | `/admin/integrations/mail/test` | delivery result | explicit pending; no cache; retryable; online |
| AI route, provider update, provider validate (3) | `/admin/ai/**` | `aiSettings` | explicit pending; authoritative settings replace cache; online |
| user create, status, roles (3) | `/admin/access/users/**` | users/user | create/result merge; status optimistic with snapshot rollback; roles pending; guarded; online |
| role create, update, delete (3) | `/admin/access/roles/**` | roles/role | result merge; delete tombstone and rollback verification; `updatedAt`; online |
| floor-plan upload/extract/job (2 hooks plus job request) | `/admin/**/floor-plans/**` | floor plans/areas | upload result inserted; extraction explicit processing modal; online |
| area create/fallback/update/delete (4) | `/admin/**/areas/**` | property areas | temp create, optimistic edit/delete, entity rollback, `expectedUpdatedAt`; online |
| marker retry/update (2) | `/admin/**/markers/**` | property areas | pending retry; optimistic marker update with rollback/version guard; online |
| area bulk delete/approve/reject/archive (4) | `/admin/**/areas/**` | property areas | tombstones; approval pending; reject/archive authoritative; guarded; online |
| technician create/status (2) | `/admin/technicians/**` | technicians/dashboard | create merge; status optimistic with rollback; online |
| inspection create/update (2) | `/admin/inspections/**` | inspections/detail/dashboard | result merge; update intended state guarded; online |
| finalize/TBD/follow-up/under-review/merge areas (5) | `/admin/inspections/**` | inspection/workflow/audit | consequential pending; result merged; scoped verification; online |
| comparison generate/review/override (3) | `/admin/**comparison**` | comparison | explicit pending; exact authoritative cache replacement; online |
| charge rule/pet generate/pet review/charge generate/create/review (6) | `/admin/**charges**`, `/pets/**` | pets/charges/report | consequential pending; authoritative response merged; online |
| report share create/revoke (2) | `/admin/**report-shares**` | shares/audit | explicit pending; authoritative merge; online |
| finding approve/reject (2) | `/admin/findings/**` | findings/audit | consequential pending; authoritative merge; online |
| assign/reassign/unassign (3) | `/admin/inspections/**assign**` | assignment/inspection | pending, stable optional idempotency key, authoritative merge; online |
| Propertyware sync | `/admin/integrations/propertyware/**` | sync/status/catalog | explicit processing; scoped verification after accepted job; online |

## Mobile technician app (21)

| Mutations | Endpoint / repository family | Entities / keys | Strategy, rollback, version and offline |
|---|---|---|---|
| demo login, API login, required password change, sign out, reset (5) | auth/Supabase | current user | explicit pending; exact cache set/clear; online except local sign-out cleanup |
| inspection start/submit (2) | `/technician/inspections/**` | inspection/context/list | explicit `PROCESSING`; authoritative response merge; guarded; online |
| area create | `/technician/inspections/:id/areas` | rooms/context | pending then authoritative insert; online |
| room note/skip/complete (3) | `/technician/rooms/**` | room/rooms/context | note optimistic with rollback; skip/complete pending and result merge; guarded |
| recording save/queue | local media + upload queue | media/upload/room | local-first durable creation; stable operation/idempotency ID; offline |
| upload pause/resume/retry/reprocess/remove (5) | durable queue / `/media/:id/reprocess` | uploads | local authoritative list replacement; retryable; offline except reprocess |
| finding approve/edit/reject/reinspect (4) | `/technician/findings/**` | finding/findings | review pending; edit response merged; guarded; online |

Queries triggered by realtime, app foreground, focus, polling, or queue progress use the same
structural guard. Current remaining limitation: non-durable online metadata edits are not queued
across an app restart; only evidence/upload work is offline-first.

