# Mobile inspection & area workflow — phase prompt (updated to current app)

Verified against the repository on 2026-07-29. Changes from the original draft are marked
**[CHANGED]**, **[REMOVED — already done]** or **[ADDED]** so the diff is reviewable.

---

## 0. Before anything — read this

### [ADDED] Timing conflict

**Remote iOS beta testing is scheduled for tomorrow.** This phase is a multi-day body of work
touching the screens the beta exercises. Landing it the night before is the single biggest risk
to that session.

Recommended: run the beta on the current build first, then start this phase. If it must start
now, do it on a branch and do not merge before the beta.

### [ADDED] Two instructions in the original draft would cause regressions

1. *"Do not implement the live camera recording system yet. Create the correct preparation
   screens and navigation targets…"* — **guided camera recording already exists and works**:
   `app/(app)/inspections/[inspectionId]/area/[areaId]/record.tsx`, plus `review.tsx` and
   `processing.tsx`, backed by `src/media/` and the guided-capture sensor logic.
   **Do not replace working capture screens with placeholders.** Leave them untouched; only add
   navigation entry points if one is missing.

2. *"Do not implement actual Cloudflare uploads yet"* — **R2 upload is already wired and live**
   (`INSPECTION_MEDIA_STORAGE_PROVIDER=r2`, `src/media/photo-upload.ts`, working upload queue).
   Do not stub it out. `VIDEO_PLATFORM_PROVIDER` is currently `mock`, so video goes through the
   mock provider — that is a config value, not something to change in this phase.

---

## 1. Stack — [CHANGED] current, verified

- Expo SDK **54.0.36**, React Native **0.81.5**, TypeScript, Expo Router, pnpm workspace
- **NativeWind 4.2.6 + Tailwind 3.4.19** — installed and confirmed bundling on iOS and web
- React Native Reusables, installed under **`src/components/ui/`**
  (`components.json` maps `@/*` → `src/*`, so *not* `components/ui/`)
- `lucide-react-native` for icons via the RNR `Icon` wrapper

### [ADDED] The RNR CLI does not work in this workspace

`@react-native-reusables/cli` and `shadcn@latest` both die on a pnpm hoisted-linker reconcile
before writing files. Install components by fetching the registry payload directly:

```
https://reactnativereusables.com/r/nativewind/<component>.json
```

then rewrite `@/registry/nativewind/components/` → `@/components/` and
`@/registry/nativewind/lib/` → `@/lib/`. See `MOBILE_REACT_NATIVE_REUSABLES_MIGRATION.md`.

### [CHANGED] Already installed — do not re-add

`text` `icon` `button` `card` `badge` `progress` `separator` `skeleton` `alert` `alert-dialog`
`dialog` `input` `label` `radio-group` `textarea` `native-only-animated-view`

**Not installed, add only if needed:** `select`, `tabs`, `switch`, `checkbox`, `avatar`.
The Add Area form can use the installed `radio-group` instead of `select`.

---

## 2. [REMOVED — already done] Shared components that exist

Do **not** recreate these. `src/components/ScreenPrimitives.tsx` already exports:

| export | purpose |
|---|---|
| `StickyActionFooter` | safe-area aware sticky footer |
| `stickyActionReservedSpace` | matching bottom inset so content is never covered |
| `KeyboardAwareFormScreen` | keyboard-aware scrolling form shell |
| `AppListScreen` | list screen shell |
| `ScreenHeader` | compact header |
| `EvidenceSummary` | evidence roll-up |

Section 9 of the original draft (build a StickyActionFooter) is therefore **already satisfied** —
reuse it, and verify it against the requirements rather than rebuilding.

Also present: `AppScreen`, `ConnectedInspectionCard`, `FeatureCards` (incl.
`UploadProgressCard`, `InspectionSummaryCard`), `ScreenStates` (Empty/Error/Loading),
`NetworkBanner`, `src/components/ui.tsx` (legacy primitives incl. `StatusBadge`, `ProgressBar`,
`FilterChip`, `SearchInput`, `ConfirmationModal`).

---

## 3. [CHANGED] Inspections screen — partially done

Already implemented:
- **Active / Done scope chips** with counts; `Active` is the default so finished work no longer
  buries live work
- `CompletedInspectionRow` — lighter row for finished inspections with a **View summary**
  action routing to the existing `report.tsx`
- Scope-aware empty states

Still required:
- **[STILL VALID] Convert to `FlatList`** — the list is currently `ScrollView` + `.map()`
  (0 `FlatList` usages), so every row mounts at once
- Card boundary/separation work, thumbnail, priority, progress bar, sync status per the
  original spec
- Pull-to-refresh, loading skeleton, error state, offline state
- Last card fully visible above the tab bar

---

## 4. [CHANGED] Area states must be DERIVED, not stored

The original draft lists 11 area states. The domain model has only four:

```ts
RoomCompletionStatus = 'NOT_STARTED' | 'RECORDING_SAVED' | 'COMPLETED' | 'SKIPPED'
```

The rest (Ready to record, Pending upload, Uploading, Processing, Evidence incomplete,
Ready to complete, Failed synchronization) must be **derived on read** from
`RoomCompletionStatus` + `UploadStatus` + `ProcessingStatus`.

**Do not add them to the enum or persist them** — duplicated status is how these screens drift
out of sync. The web app solved the same problem with a derived `AreaReviewStatus`; mirror that
precedence approach.

Note the real value names when writing conditionals — `READY_FOR_REVIEW`, not `READY`:

```ts
ProcessingStatus = 'NOT_STARTED' | 'VIDEO_PROCESSING' | 'TRANSCRIBING' | 'ANALYZING'
                 | 'COMPARING_BASELINE' | 'PREPARING_FINDINGS' | 'READY_FOR_REVIEW' | 'FAILED'
UploadStatus     = 'PENDING' | 'UPLOADING' | 'PAUSED' | 'FAILED' | 'COMPLETED'
```

---

## 5. [CHANGED] Theme tokens already exist — use them

`tailwind.config.js` + `global.css` already define the full semantic set, verified complete
(46 references, 0 missing):

`background` `foreground` `card` `popover` `primary` `secondary` `muted` `accent` `destructive`
`border` `input` `ring` `success` `warning` `info` `offline` `pending-sync` `uploading`
`processing` `needs-review` `approved` `rejected` `failed` `recording` `capture-guide`
(each with a `-foreground` pair) plus `chart-1..5`.

Values derive from `src/theme/colors.ts`, which stays authoritative. **Add new colours there
first**, then mirror into `global.css`. Do not introduce hard-coded hex in screens.

---

## 6. [STILL VALID] Add Area workflow

No Add Area route exists — this is genuinely new. Build it as a full-screen route under
`app/(app)/inspections/[inspectionId]/areas/new.tsx` (or similar), using
`KeyboardAwareFormScreen` and `radio-group`, not a constrained dialog.

Fields, options, validation, save/cancel, offline-pending and retry states: as originally
specified.

---

## 7. [STILL VALID] Sections carried over unchanged

3 (Inspection Overview) · 4 (Area List / AreaCard) · 6 (Area Details) · 7 (Area Actions) ·
10 (Navigation header) · 11 (State consistency) · 13 (Responsive & accessibility) ·
14 (Mock data).

Two notes:

- **[ADDED] Mock data** already exists at `src/repositories/mock/data.ts`, gated by
  `EXPO_PUBLIC_ENABLE_DEMO_DATA`. Extend that rather than creating a parallel fixture set. Be
  aware the app currently runs against the **real API** in remote-beta mode.
- **[ADDED] State consistency** — the existing upload queue and offline store already implement
  much of section 11. Audit before rebuilding.

---

## 8. [CHANGED] Completion criteria

Original list, minus what is already true, plus what verification actually requires:

- [ ] Inspection list uses `FlatList` with clear card boundaries
- [ ] Area list uses `FlatList`; exactly one area marked **Up next**
- [ ] Inspection Overview implemented with grouped areas
- [ ] Area Details has the specified evidence hierarchy
- [ ] Add Area is a full-screen keyboard-aware form
- [ ] Derived area states — no new persisted status field
- [x] Sticky footer exists (`ScreenPrimitives`) — verify it never covers content
- [ ] Light and dark verified **on device**, not only by token audit
- [ ] Slow/failed mock actions do not flash old state
- [ ] Empty, loading, error and offline states on every new screen
- [ ] Existing camera, upload and navigation behaviour **unchanged**
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass
- [ ] `npx expo export --platform ios` succeeds

Current baseline to preserve: **18 test suites / 94 tests**, iOS bundle **8.98 MB**, web bundle
**5.11 MB** — all passing.
