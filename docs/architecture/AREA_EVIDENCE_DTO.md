# Area evidence DTOs

Defined in `shared/src/contracts/area-evidence.ts`, served by
`backend/src/admin/area-evidence.service.ts`.

The service is a **read model**: it aggregates existing records and owns no
tables. No migration was required — the relational model already carried
everything needed.

## Existing relationships used

| Relation | Nullability | Index |
|---|---|---|
| `InspectionMedia.inspectionAreaId` | NOT NULL | `@@index([inspectionAreaId])` |
| `InspectionPhoto.inspectionAreaId` | NOT NULL | `@@index([inspectionAreaId, captureType, sequenceNumber])` |
| `InspectionPhoto.findingId` | nullable | `@@index([findingId])` |
| `InspectionFinding.propertyAreaId` | NOT NULL | `@@index([inspectionId, reviewStatus])` |
| `InspectionFinding.inspectionMediaId` | NOT NULL | — |

**One trap worth knowing:** media and photos key on `InspectionArea.id`, while
findings key on `PropertyArea.id` — the catalog area, not the per-inspection
one. The service maps between them explicitly. Joining findings on
`inspectionAreaId` silently returns nothing.

## `AreaEvidenceSummary`

```
inspectionId
totals   { areas, areasReviewed, recordings, photos, findings, unreviewedFindings }
areas[]  { id, propertyAreaId, name, floorName, environment, isRequired,
           completionStatus, reviewStatus, counts, evidence, lastEvidenceAt }
unassigned { recordings, photos }
```

`evidence` carries only presence booleans — `primaryRecordingAvailable`,
`overviewPhotoAvailable`, `conditionSummaryAvailable` — so a reviewer can judge
an area without opening it.

**Invariant: the summary contains no `contentPath`, `thumbnailUrl` or
`storageKey`.** A test asserts this on the serialized payload; it is the whole
reason the list is cheap.

## `AreaEvidenceBundle`

```
area             { …, reviewStatus, skipReason, technicianNote }
conditionSummary { id, description, createdAt, reviewStatus } | null
recordings[]     { …, thumbnailUrl, contentPath }
photoGroups[]    { key: OVERVIEW | FINDING | SUPPORTING, findingId?, photos[] }
findings[]       { …, recordingId, videoTimestampStart/End, photoCount, lastReview }
counts
```

`photoGroups` is what keeps finding evidence attached to its finding rather than
collapsing into one flat gallery: photos with a `findingId` are emitted as their
own group, labelled with the finding's title.

The condition summary is a `NO_CHANGE` finding carrying a reserved title
(`ROOM_SUMMARY_WHERE`) and is excluded from `findings[]`, so the narrative and
the itemized list never duplicate each other.

## Deliberately excluded

Transcripts, raw AI provider responses, prompts, provider settings, audit
history, and any media belonging to another area.

## Query cost

Summary: 1 area read + 1 media read + 3 `groupBy` calls, independent of area
count. Bundle: 4 reads for one area, plus one signature per recording (poster
only — playback URLs are minted on demand).
