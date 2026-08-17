# web

The TexasRenters admin console. Next.js 15 App Router on canonical shadcn/ui.

```bash
npm run dev:web     # http://localhost:5456
```

Port **5456** (`WEB_DEV_PORT`), deliberately clear of the `web` container's **5454** (`WEB_PORT` in
the compose files), which is routinely up at the same time. Those two are different things: 5454
serves a production build with no hot reload, so pointing this dev server at it is how you end up
unsure which one you are looking at.

> **Naming.** This package began as `web-shadcn/`, a rebuild running beside the original `web-app/`.
> `web-app` was deleted and this took its name in `aadd149`. Sections below that compare the two are
> kept as the record of *why* the rebuild happened; `web-app` no longer exists in the tree.

> The backend must allow `http://localhost:5456`. It is in `DEVELOPMENT_ORIGINS` in
> `backend/src/main.ts` and in `backend/.env.local`, but the remote-beta stack runs
> `NODE_ENV=production`, where **only** `CORS_ALLOWED_ORIGINS` applies — so that stack needs a
> restart after the env change or every request fails at the preflight with a missing
> `Access-Control-Allow-Origin`.

## Why a rebuild, when web-app already has shadcn

`web-app` has the primitives but also `app/globals.css` at **5,031 lines across 400 bespoke class
selectors**, plus `auth.css` and a hand-assembled `tailwind.css` that **omits Tailwind Preflight** so
those selectors keep working. That is why a utility there can silently lose to an unlayered legacy
rule, and why five style regressions were invisible to lint, typecheck, tests and `next build`.

Here `app/globals.css` is **~180 lines of tokens**, Preflight is on, and there are **no bespoke class
selectors at all**. An ESLint rule fails the build on a raw colour in a `className`, which is the way
that erodes.

## What is shared with web-app, and what is not

**Copied verbatim — this is what "same API and same auth" means:**

`middleware.ts`, `app/api/session/*`, `lib/api.ts`, `lib/session.ts`, `lib/session-cookies.ts`,
`lib/auth-session.ts`, `lib/queries.ts`, `lib/realtime.tsx`, `lib/state-consistency.ts`,
`lib/inspection-progress.ts`, `lib/area-checklist.ts`, `lib/playback.ts`, `lib/clock.ts`,
`lib/property-label.ts`, `lib/access.ts`, `lib/admin-navigation.ts`, `lib/use-debounced-value.ts`.

Same `tr_access` / `tr_refresh` cookies, same endpoints, same session semantics. The logo PNG and
`icon.svg` favicon are the same files.

**Rewritten:** everything under `app/**/page.tsx` and `components/`.

**Dropped:** `lib/theme.tsx` and `lib/theme-script.ts` — replaced by `next-themes` with a `.dark`
class, keeping the same `texasrenters-admin-theme` storage key so an existing preference carries over.

## Theme

Neutral shadcn slate for surfaces, borders and text. Brand blue `#1d4492` is `--primary`; brand green
`#85c43f` is a separate `--brand` token, **deliberately not `--accent`** — in shadcn `--accent` is the
neutral hover surface for menus, rows and command items, so putting the brand there turns every hover
green.

## UX changes over web-app

These are intentional. Feature parity is fixed; layout and interaction are not.

- **Filters live in the URL** (`lib/url-state.ts`). A filtered list is shareable, bookmarkable, and
  survives refresh and the back button. Previously all of it was `useState`.
- **Whole rows are clickable**, via a stretched link on the primary cell — keyboard-reachable and
  announced, which an `onClick` on `<tr>` is not. That is why the old app needed an "Open" icon
  button in every row as the only real control.
- **One loading treatment.** The skeleton is generated from the same `Column[]` as the table, so the
  two cannot drift. The old app kept a separate `headers` array for the skeleton, and flipped from a
  brand animation to a skeleton 350ms into the same wait.
- **Active filters render as removable chips**, so an empty table caused by a filter set ten minutes
  ago is legible without opening each dropdown.
- **⌘K command palette** over the same permission-filtered navigation the sidebar uses.
- **Page headers are compact** — the "TEXASRENTERS OPERATIONS" eyebrow is gone; the breadcrumb in the
  sticky header already says where you are.
- **Content is capped at 1600px** and centred, instead of running the full width of a 27" monitor.
- Password fields have a reveal toggle, and the reset screen lists all five policy rules and ticks
  them live rather than reporting one failure per submit.

### Inspections are split by type

Each `InspectionType` is its own section, reached from sub-items under **Inspections** in the
sidebar. They are the **same route carrying `?type=`**, not nested routes — `/inspections/move-out`
would be captured by the `[inspectionId]` segment and fetched as an inspection id.

The pieces, all keyed off that one search param:

- `lib/admin-navigation.ts` — `children` on the Inspections item, `activeNavigationChild`,
  `navigationChildHref`, and the second breadcrumb crumb. Sub-items are active only on the list
  itself: a detail page belongs to no single type, so it highlights the parent and no child.
- `components/app-sidebar.tsx` / `components/app-header.tsx` — both read `useSearchParams`, so both
  put it behind a `Suspense` boundary whose fallback is the same tree without the type. They are
  mounted by the layout on **every** admin route; unguarded, one `useSearchParams` there opts all of
  them out of prerendering.
- `NavigationSection` in `components/app-sidebar.tsx` — the **Inspections** header does not navigate;
  it collapses and expands the types. Exported only so `app-sidebar.test.tsx` can drive it.
- `app/(admin)/inspections/page.tsx` — title, description, empty state and the **Create** button all
  follow the type (`/inspections/new?type=…` prefills the form; the select stays editable).

Consequences worth knowing before changing it:

- **`type` is the section, not a filter.** It gets no removable chip and is excluded from
  `hasNarrowingFilters`, so "Clear filters" cannot silently eject you from the section. Leave a
  section via the sidebar parent or the breadcrumb.
- **The Type dropdown was removed** from the toolbar. It was a second, competing way to be in a
  section, and one that left the sidebar and page title disagreeing with the list.
- **Scheduled-date bounds took its place** — with the types separated, the remaining question is
  historical ("which move-ins did this property have before September"). `lib/date-range.ts` widens
  both ends to cover the whole local day; the upper bound is the *last* instant, because the API
  compares `lte` against a timestamp and a bare date would drop everything scheduled that afternoon.
- A type added to the enum and not to `children` is reachable only by typing the URL —
  `lib/admin-navigation.test.ts` asserts the two stay in step.
- **The section header is a `<button>`, not a link,** and the collapsible is hand-rolled rather than
  Radix `Collapsible` + `CollapsibleTrigger asChild` (the shape the shadcn sidebar example uses).
  `SidebarMenuButton` given a `tooltip` returns a `<Tooltip>` root, which renders no DOM of its own;
  `asChild` clones *that*, so the trigger's `onClick` and aria wiring land on a component that
  ignores them and the header silently stops working. Dropping the tooltip is not an option — it is
  the button's only label once the sidebar is collapsed to the icon rail.
- On the icon rail the sub-items are hidden by the sidebar's own styles, so the header widens the
  sidebar instead of toggling. Without that, an inert header would make the section unreachable
  while collapsed.
- The combined "all types" list still exists at `/inspections`; the breadcrumb's **Inspections**
  crumb is now the only way to it.

## Deployment

**This is the console the Docker stack serves.** The compose `web` service builds
`docker/web/Dockerfile` on port **5454**. There is no longer a choice of console to make here: the
`dockerfile:` line used to select between this package and `web-app`, and since `aadd149` deleted
`web-app` there is only one, with no revert path to switch back to.

Compose interpolates `NEXT_PUBLIC_*` **build args** from its `--env-file`, and it reads only that
flag and the root `.env` — never a service's own `env_file`. All three entry points point at
`web/.env.local`, and missing one still starts a stack, with the console silently talking to
whichever backend that file happens to name:

| | |
|---|---|
| `npm run docker:up` | `--env-file web/.env.local` |
| `scripts/remote-beta/start.mjs` | `WEB_ENV_FILE` |
| `scripts/remote-beta/status.mjs` | `WEB_ENV_FILE` |

Only `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_ENABLE_DEMO_DATA` are interpolated, and those are
exactly the two keys `web/.env.local` defines. **A change to that file needs a rebuild, not a
restart** — Next inlines the value into the bundle at build time.

**The console is not published to the internet, and never has been.** The tunnel maps
`backend.erniecodev.win → backend:3000` and `mobile.erniecodev.win → host:8082`; there is no
hostname for `web:5454`, and the backend's `CORS_ALLOWED_ORIGINS` contains only localhost entries.
Reaching it from another machine needs both a Cloudflare ingress rule and that origin added to
`CORS_ALLOWED_ORIGINS` — the second is the step that gets forgotten, and it presents as a CORS error
that looks like a backend bug.

## Status

**Feature-complete.** Every route in `web-app` had a counterpart here before it was deleted, verified
by diffing the two route trees rather than by assumption. The check was, while both existed:

```bash
# Historical. Neither path exists now; kept as the record of how parity was established.
diff <(find web-app/app -name page.tsx -o -name route.ts | sed 's|web-app/app||') \
     <(find web-shadcn/app -name page.tsx -o -name route.ts | sed 's|web-shadcn/app||')
```

`next build` green (26 routes) · `tsc --noEmit` clean · `eslint` exit 0.

| | |
|---|---|
| Shell | sidebar, sticky header, command palette, theme toggle, `AdminGuard` |
| Auth | `/login`, `/forgot-password`, `/reset-password` |
| Admin | dashboard, properties (+detail), inspections (+detail, new, charge-report), assignments, technicians (+detail), users (+detail), roles, profile, settings, integrations ×2 |
| Public | `/report/[token]` and `/report/[token]/pdf` |
| Floor plans | `FloorPlanManager`, canvas, marker layer, checklist, zoom/page controls, `AreaChecklistDialog` |
| Inspection review | `AreaEvidenceWorkspace`, `AreaDetailPanel`, `EvidenceViewer`, `LazyPhoto`, `RecordingSurface`, workflow, charges, comparison, evidence-request |
| Dialogs | technician/user create, role editor, assignment create + reassign, delete account, report share, edit/cancel/unassign/finalize/merge |
| Primitives | 32 in `components/ui/` at stock shadcn defaults |

**Tests:** 21 suites, 182 tests, all passing (`npm test:web`).

The eleven pure-logic suites — `lib/api`, `auth`, `clock`, `playback`, `property-label`,
`admin-navigation`, `inspection-progress`, `state-consistency`, `use-debounced-value`,
`report-pdf/render-report-pdf`, `floor-plan/floor-plan-geometry` — were copied from `web-app` and
**passed unchanged on the first run**, which is the evidence that the ported `lib/` layer is
faithful rather than merely similar.

Four suites are new here rather than ported — `lib/date-range`, `components/app-sidebar`,
`shared/tests/permissions`, and the inspection-type half of `lib/admin-navigation`. Each was written
against a behaviour that had already broken once, and each was checked by **regressing the
implementation on purpose** to confirm it fails: a test that has never been seen red is a test that
has never been shown to work.

Three ported suites needed updating, each because the markup they asserted on changed on purpose:

- `header-clocks` asserted the date was visible text; it now lives in the accessible name and the
  tooltip, so the test asserts that instead.
- `area-checklist-dialog` looked for a label reading `Item`; the heading and the duplicate label
  merged into one `Add an item`.
- `ui/alert` asserted `web-app`'s exact utility classes (`grid-cols-[0_1fr]`, `has-[>svg]:pl-11`).
  Rewritten to assert behaviour — that the alert is announced, that a bare string renders without a
  title wrapper, and that two variants do not produce identical markup. A class-string assertion
  breaks on any legitimate restyle while catching nothing.

### Inspection deletion

This console added a capability `web-app` never had: permanently deleting an inspection, behind a
new **`inspections:delete`** permission.

It is a separate key from `inspections:manage` on purpose — managing means editing and cancelling,
and *cancelling is the reversible way to close an inspection*. This one is not reversible, so it can
be withheld from the same people trusted to run the rest of the workflow.

- **No role has it yet.** Grant it on `/roles` before the menu item appears.
- Works on **any** status, including finalized. Everything else on that menu refuses a finalized
  inspection; this one does not, because deleting a report is a different act from quietly editing
  one. The dialog says so when the inspection was finalized.
- Deletes the evidence for real: Cloudflare Stream videos via a new
  `CloudflareStreamService.deleteVideo`, and photos from object storage.
- Storage is cleared **after** the database transaction commits, never before. Deleting objects first
  would destroy footage for an inspection that still exists if the transaction then rolled back —
  the one failure mode with no recovery. A storage error instead leaves an orphan, which costs money
  but loses nothing, and is returned as `orphanedStorageObjects` rather than swallowed.
- Inspections that depend on this one (a move-out using it as a baseline, a follow-up naming it as
  parent) are **unlinked, not deleted**. Both columns are `onDelete: Restrict`, so the delete would
  otherwise fail outright. The counts go into the audit entry so the missing baseline is explainable.
- The audit row survives: `AuditLog.entityId` is a plain string with no foreign key to `Inspection`.

The delete order in `AdminService.eraseInspection` is dictated by the schema, not preference — most
children of `Inspection` have **no** `onDelete: Cascade`, so a bare `inspection.delete()` fails on
the first foreign key. Two parts of it are not derivable from a reading of `schema.prisma`, and both
shipped broken before being found:

- **Four tables key on `inspectionMediaId`, not `inspectionId`** — `aiAnalysisJob`,
  `transcriptionJob`, `mediaProcessingEvent`, and `transcriptSegment` (one hop further out, via
  `TranscriptionJob`). An enumeration that greps for `inspectionId` misses all of them, and any
  inspection whose recording had been transcribed failed to delete. The last one was only found by
  querying the **database's own** constraint graph rather than re-reading the schema file.
- **Findings are deleted before media**, because `InspectionFinding.inspectionMediaId` points *at*
  media. The reverse order reads naturally and fails on the foreign key.

**Where the controls are.** A bin icon on each row of `/inspections`, and *"Delete permanently…"*
inside the `⋯` menu on the detail page. Both open the same confirmation, which asks you to type the
property name.

**Bulk delete.** Tick rows on `/inspections` and a bar appears above the table. It posts to
`POST /admin/inspections/delete` with up to **50** ids.

- Each inspection is erased in **its own transaction**, sequentially — not one outer transaction.
  A batch that wraps everything scales its statement count with the data and the remote pooler drops
  it at five seconds with "Transaction not found", which is exactly the shape of deleting twenty
  inspections' worth of media. It also means partial success is possible, which for clearing test
  data beats all-or-nothing.
- So the response reports **per-id outcomes**, and the dialog stays open on a partial failure to
  show which ones refused and why. The ones that succeeded drop out of the selection; the rest stay
  selected so they can be retried without hunting for them.
- Selection is **dropped for rows the current page no longer shows**. Otherwise a filter change
  leaves ids selected that the reader cannot see, and the bar offers to delete inspections they have
  no way to review.
- The single-row dialog has you type the *property name*; the bulk one has you type `DELETE`. They
  ask different questions — one is "which inspection", the other is "do you realise how many".

### Dead code not carried over

`web-app/components/inspection-review.tsx` (566 lines) exported five things. Only
`InspectionCompleteDialog` was ever imported — `InspectionMediaSection`, `InspectionPhotosSection`,
`InspectionSummariesSection` and `InspectionFindingsSection` were the four page-wide,
media-type-first panels that `AreaEvidenceWorkspace` replaced, and nothing has referenced them since.
The dialog lives in `components/inspection-complete-dialog.tsx` here; the other ~430 lines are gone.

### Notes from the floor-plan port

- The PDF pipeline (`lib/report-pdf/*`) is a **verbatim copy**. `@react-pdf/renderer` uses its own
  StyleSheet, not DOM CSS, so it was never affected by the UI rebuild.
- Both hand-rolled modals in `floor-plan-manager` became shadcn `Dialog`s, deleting ~100 lines that
  reimplemented the focus trap, scroll lock, Tab cycle and focus restore that Radix already does.
- The comparison view shows the plan and the checklist **side by side** above `lg`. The old one hid
  one behind a "Show plan / Review areas" toggle at every width, so on a laptop you could never see
  both at once.
- `AreaMarker` carries `data-fp-marker` purely so the canvas can ask
  `closest('[data-fp-marker]')` whether a pointerdown hit a marker. Every class on it is a Tailwind
  utility that could change for visual reasons; the attribute cannot be restyled away by accident.

## Conventions

- Build list pages from `DataTable` + `ListToolbar` + `Pagination` + the `states.tsx` trio. Do not
  hand-write `<TableRow>`; define a `Column[]` so the table, its skeleton and its empty state stay in
  step.
- Never put a raw colour in a `className` — ESLint fails the build on it. Use the tokens.
- `asChild` needs an element-typed slot from `components/ui/slot.ts`; the bare `Slot` export is typed
  `HTMLAttributes<HTMLElement>` and will not accept `ComponentProps<'button'>`.
- Keep `@types/react` at `^19.2.0`. Dropping to `^19.1.0` makes npm run nest a second copy under
  `@types/react-dom`, and every `asChild` component then fails with "Two different types with this
  name exist".
