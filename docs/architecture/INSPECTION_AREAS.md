# Inspection areas

An **area** is a discrete inspection target (a room, a closet, or an outdoor
target such as a fence). Areas are modeled once per property as `PropertyArea`
and linked to each inspection via `InspectionArea`.

## Provenance (`source`)

`PropertyArea.source` is a string with a fixed vocabulary (kept as a string,
not an enum, to avoid churning historical rows):

| source            | Created by                                             |
| ----------------- | ------------------------------------------------------ |
| `AI_FLOOR_PLAN`   | Floor-plan extraction (AI).                            |
| `MANUAL`          | Administrator, via the property area editor.           |
| `MANUAL_FALLBACK` | Auto-created "Entire property" area when none existed. |
| `TECHNICIAN`      | Technician, on site (see below).                       |

## Approval status (`status`)

`DRAFT → APPROVED` (bulk `POST /admin/properties/:id/areas/approve`) or
`DRAFT → REJECTED` (`POST /admin/property-areas/:id/reject`). Extracted and
technician-added areas both begin `DRAFT`. Editing is only allowed while `DRAFT`.

## Archive (`archivedAt`)

Archiving (`POST /admin/property-areas/:id/archive`) sets `archivedAt`. Archived
areas drop out of active admin lists and the technician checklist but **retain
all media and findings** — it is a soft, reversible hide, never a delete. Hard
delete stays blocked while an inspection references the area.

## Classification

- `environment`: `INDOOR | OUTDOOR | SEMI_OUTDOOR` (default `INDOOR`). See
  [OUTDOOR_INSPECTIONS.md](./OUTDOOR_INSPECTIONS.md).
- `category`: a finer `AreaCategory` (e.g. `YARD`, `PERIMETER_FENCE`, `CLOSET`).
- `createdBy`: the user who created a manual/technician area.
- `notes`: free text captured at creation.

## Technician-added areas

`POST /api/v1/technician/inspections/:inspectionId/areas` lets an assigned
technician add a missed, mislabeled, or outdoor area on site. The endpoint
creates a `DRAFT` `PropertyArea` with `source: TECHNICIAN`, auto-assigns the next
`inspectionOrder`, guards against duplicate names on the same floor, links a new
`InspectionArea`, and writes a `TECHNICIAN_AREA_ADDED` audit event — all in one
transaction. Evidence can be captured immediately, but **a technician can never
approve an area**; an administrator approves, rejects, or archives it. Renames
and merges never delete media — prior names are preserved as
`PropertyAreaAlias` rows.

## Aliases

`PropertyAreaAlias` stores prior/alternate names for an area (rename and, later,
merge history). It keeps evidence associated after a rename and feeds move-in vs
move-out area matching in the comparison engine (a later phase).
