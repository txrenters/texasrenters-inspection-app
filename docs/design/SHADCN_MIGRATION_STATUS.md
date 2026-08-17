# shadcn/ui Migration Status — web-app

Authoritative continuation state. Resume by reading this file, checking `git status`, and
starting at **§16 Next exact target**.

## 1. Configured shadcn base

**Radix UI**. Confirmed from `web-app/components.json`, the existing
`@radix-ui/react-*` dependencies, and the current shadcn CLI output. The official
sidebar generator now imports `Slot` from the unified `radix-ui` package, which the
CLI added. There is **no** Base UI and **no** React Aria dependency, so the Base UI
Sheet variant is out of scope — use the generated Radix Sheet behavior.

## 2. Configured shadcn style

`new-york` · baseColor `slate` · `cssVariables: true` · `rsc: true` · `tsx: true` ·
iconLibrary `lucide` · css entry `app/tailwind.css` · aliases `@/components`, `@/components/ui`,
`@/lib`, `@/hooks`.

Toasts: `sonner` (single system, already aligned).

## 3. Routes discovered (22)

- [x] `app/page.tsx`
- [x] `app/login/page.tsx`
- [x] `app/forgot-password/page.tsx`
- [x] `app/reset-password/page.tsx`
- [x] `app/report/[token]/page.tsx`
- [x] `app/(admin)/dashboard/page.tsx`
- [x] `app/(admin)/assignments/page.tsx`
- [x] `app/(admin)/inspections/page.tsx`
- [x] `app/(admin)/inspections/new/page.tsx`
- [x] `app/(admin)/inspections/[inspectionId]/page.tsx`
- [x] `app/(admin)/inspections/[inspectionId]/charge-report/page.tsx`
- [x] `app/(admin)/integrations/propertyware/page.tsx`
- [x] `app/(admin)/integrations/providers/page.tsx`
- [x] `app/(admin)/profile/page.tsx`
- [x] `app/(admin)/properties/page.tsx`
- [x] `app/(admin)/properties/[propertyId]/page.tsx`
- [x] `app/(admin)/roles/page.tsx`
- [x] `app/(admin)/settings/page.tsx`
- [x] `app/(admin)/technicians/page.tsx`
- [x] `app/(admin)/technicians/[technicianId]/page.tsx`
- [x] `app/(admin)/users/page.tsx`
- [x] `app/(admin)/users/[userId]/page.tsx`

## 4. Shared components discovered

`app-shell` · `shared.tsx` (PageHeader/MetricCard/Loading/Error/Empty/Table helpers) ·
`status-badge` · `searchable-select` · `providers` · 8 dialog components ·
`area-evidence/*` · `floor-plan/*`.

## 5. Legacy components discovered

None remaining as separate primitive systems. `shared.tsx` `Badge` is a thin alias over
`status-badge`, which composes `ui/badge`.

## 6. Legacy styles discovered (`app/globals.css`)

Counts are `className="…"` occurrences in `app/` + `components/`.

- [x] `.panel*` — 35 → **0** (all 17 files converted to `Card`)
- [x] `.button*` — removed earlier
- [x] `.dialog*` — removed earlier
- [x] `.badge/.metric/.page-header/.table/.state/.filter` families — removed earlier
- [x] `.field*` — 110 → **0** (markup and CSS both removed)
- [x] `.alert*` — 21 → **0**
- [x] `.media-meta` — 36 → **0**
- [x] `.section-kicker` — 20 → **0**
- [x] `.detail-item` / `.detail-grid` — 20 → **0**
- [x] `.table-link` — 8 → **0**
- [x] `.floor-plan-muted` — 7 → **0**
- [x] `.supporting-copy` / `.source-chip` / `.issue-*` / `.readiness-*` / `.sync-action*` — **0**
- [x] `.area-*` (72) — reviewed; specialized media/canvas surfaces retained (see §15)
- [x] `.workflow-*` (13) — converted

## 7. Migration phases

- [x] P0 Foundation — Tailwind v4, tokens, `components.json`, Radix base
- [x] P1 Primitives — button, badge, card, dialog, alert-dialog, dropdown-menu, sheet, skeleton, sonner
- [x] P2 Overlays — 14 hand-built/native overlays → Dialog/Sheet/AlertDialog
- [x] P3 Status — 48-status `status-badge`
- [x] P4 Panels → Card — 17 of 17 files, 35 of 35 usages
- [x] P5 Added primitives — input, label, textarea, select, tabs, table, tooltip, progress, separator, checkbox, alert, empty, spinner
- [x] P6 Forms — one Field system; 0 legacy form classes remain
- [x] P7 Tables — `DataTable`/`TableLoadingState` rebased on `ui/table.tsx`; 111 raw
      `tr`/`td`/`th` across 11 routes converted; bare `table{}` + `.charge-report-table` CSS removed
- [x] P8 Loading/Empty/Error — Skeleton + Empty
- [x] P9 Legacy CSS prune — `.panel*` + `.field*` gone; globals.css 5,476 → 5,319
- [x] P10 Enforcement — `no-restricted-syntax` in root `eslint.config.mjs` bans legacy
      class names, raw `<table>`/`<thead>`/`<tbody>` and native `<dialog>` outside
      `components/ui`; probe-tested to confirm it fires

## 8. Route-by-route checklist

See §3 — all 22 migrated.

## 9. Shared-component checklist

- [x] `PageHeader` · `PageToolbar`
- [x] `StatusBadge`
- [x] `PageLoadingState` / `PageErrorState` / `NoResultsState` (Empty)
- [x] `DataTableToolbar` (filter bar)
- [x] Dialog family (8)
- [x] `AreaEvidenceCard` / area workspace
- [x] `searchable-select` → Radix Popover/Command-style composition

## 10. Tests required

- [x] `components/ui/__foundation.test.tsx`
- [x] `status-badge.test.tsx`
- [x] `shared.test.tsx`
- [x] `searchable-select.test.tsx`
- [x] `area-evidence/area-evidence.test.tsx`

## 11–14. Current status

| check | result |
|---|---|
| lint | **pass** |
| typecheck | **pass** |
| tests | **pass** — 17 files / 81 tests |
| build | **pass** — 25 routes; 20/20 static pages |

## 17. Official sidebar migration

Completed July 29, 2026.

- [x] Generated the current official `sidebar` primitive with
  `npx shadcn@latest add sidebar`.
- [x] `components/ui/sidebar.tsx` is the unmodified current CLI output.
- [x] Kept the repository-owned Button, Input, Separator, Sheet, Skeleton, and
  Tooltip implementations when the CLI offered to overwrite them.
- [x] Added only the newly required official Sidebar, Avatar, Breadcrumb, and
  `use-mobile` files.
- [x] Replaced the custom fixed sidebar, local-storage collapse state, overlay,
  hand-authored SVG map, and responsive CSS with `SidebarProvider`,
  `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`,
  `SidebarMenuButton isActive`, `SidebarRail`, `SidebarInset`, and
  `SidebarTrigger`.
- [x] Uses `collapsible="icon"` and the flush `variant="sidebar"` layout so the
  navigation and page canvas meet without an artificial outer gutter.
- [x] Desktop collapse is persisted by the official `sidebar_state` cookie and
  read in the server layout to avoid a hydration flash.
- [x] Mobile navigation uses the official Radix Sheet behavior and closes after
  navigation.
- [x] Navigation and permission metadata are centralized in
  `lib/admin-navigation.ts`.
- [x] Route matching uses exact path-segment boundaries and supports detail and
  workflow descendants without substring collisions.
- [x] Footer account dropdown includes Profile, permitted Settings, and safe
  local sign-out.
- [x] Removed legacy sidebar/topbar/mobile-overlay CSS and old sidebar tokens.
- [x] Added branded semantic sidebar tokens for light and dark themes through
  `bg-sidebar`, `text-sidebar-foreground`, and related shadcn token mappings.
- [x] Kept no-Preflight compatibility resets at the application composition
  points: menu list margins/markers and native header, footer, and rail button
  surfaces.
- [x] Added route, permission, breadcrumb, provider/inset adjacency, collapse,
  rail, cookie, shortcut, tooltip, account, sign-out, and mobile Sheet tests.
- [x] Browser review completed at desktop expanded/collapsed and mobile
  breakpoints in light and dark themes; no browser warnings or errors. The
  measured desktop boundary has `0px` physical gap, and the page has no
  horizontal overflow.

No artificial nested menu was added because the current information
architecture has no parent item with independently navigable child routes.
Nested detail routes correctly keep their owning top-level item active.

## 15. Known blockers / justified exceptions

### Specialized surfaces retained by design

Spec §"Do not convert specialized canvases" permits custom implementation for the
floor-plan canvas, marker overlay, zoom/pan, video player surface and image viewer
surface. Their **surrounding controls** all use shadcn.

The `.area-*` audit (47 distinct classes) resolved as:

| group | classes | disposition |
|---|---|---|
| Media surfaces | `area-recording*` (5), `area-photo*` (5) | **keep** — video player + image viewer surfaces |
| Evidence workspace layout | `area-evidence-*` (9), `area-detail*` (3), `area-finding*` (6) | **keep** — master/detail workspace for media review |
| Ordinary utilities | `area-meta` (9), `area-detail-section` (4), `area-list`, `area-list-meta`, `area-list-item`, `area-select-box`, `area-finding-title`, `area-finding-status` | **converted** — 18 occurrences → Tailwind tokens |
| Dead hooks (no CSS rule anywhere) | `area-heading`, `area-summary`, `area-statuses`, `area-main`, `area-item`, `area-grid`, `area-groups`, `area-group`, `area-order`, `area-form`, `area-review-list`, `area-heading-select` | **removed from markup** |

## 16. Next exact target

### Browser verification — authenticated pass done

Verified live against `http://localhost:5454` (user's own dev server; this session
started and stopped nothing).

**Two real regressions found and fixed — neither was visible to lint, typecheck,
79 tests or the production build.**

1. **Form controls rendered black text.** Native inputs do not inherit `color`, and
   the deleted `.field input { color: … }` rule was what supplied it. In dark mode
   that is black on `rgb(11,18,32)` — you could not read what you typed. Added
   `text-foreground` to `ui/input.tsx`, `ui/textarea.tsx`, `ui/select.tsx`.
   **Confirmed fixed live:** input now computes `rgb(242,246,252)` on `/inspections`.

2. **The Table primitive was completely inert.** `app/globals.css` still carried
   unlayered element selectors (`th, td { padding: 13px 14px }`, `th { font-size:11px;
   text-transform:uppercase }`, `tbody tr:hover`, …). Unlayered rules beat
   `@layer utilities`, so every table was styled by legacy CSS and `ui/table.tsx` did
   nothing. Removed the 23-line block and folded the subtle header background into
   `TableHeader`. **Confirmed live:** `td` padding 13px→12px, `th` 11px→12px,
   `text-transform` uppercase→none (the spec bans tiny uppercase labels).

**Verified clean:** `/dashboard` — 12 Cards, `bg rgb(18,28,45)`, `border rgb(42,57,80)`,
no horizontal overflow, no collapsed containers. `/inspections` — 7 rows, wrapper
`overflow-x:auto` so the table scrolls inside its own container, page does not.
Dark theme correct on both.

`app/globals.css` is now **4,861 lines** (5,996 at migration start).

### Routes walked (live, both themes)

| route | cards | tables | overflow | collapsed | unreadable |
|---|---|---|---|---|---|
| `/dashboard` | 12 | 0 | ok | 0 | 0 |
| `/inspections` | — | 1 (7 rows) | ok | 0 | 0 |
| `/inspections/[id]` | 6 | 1 | ok | 0 | 0 |
| `/properties` | 1 | 1 (20 rows) | ok | 0 | 0 |
| `/properties/[id]` | 4 | 1 | ok | 0 | 0 |
| `/settings` | 5 | 0 | ok | 0 | 0 |
| `/integrations/propertyware` | 5 | 1 | ok | 0 | 0 |

"Collapsed" = visible containers with children and zero height. "Unreadable" =
elements whose text colour equals their own background. Both zero everywhere.

Card padding resolves to the three intended values: `22px` (standard panel),
`0px` (the `inspection-overview` Card, which preserves the old
`.inspection-overview { padding: 0 }`), and `24px`. Table cells 12px, header
12px non-uppercase, header background subtle — the primitive is governing.

**Theme parity confirmed** on `/inspections/[id]`:

| token | light | dark |
|---|---|---|
| body bg | `rgb(245,247,251)` | `rgb(11,18,32)` |
| body text | `rgb(20,33,58)` | `rgb(242,246,252)` |
| card bg | `rgb(255,255,255)` | `rgb(18,28,45)` |
| card border | `rgb(217,224,234)` | `rgb(42,57,80)` |
| thead bg | `rgb(250,251,253)` | `rgb(22,34,54)` |

### Floor-plan manager + area-evidence workspace

Both render unconditionally on the detail pages (`properties/[propertyId]:173`,
`inspections/[inspectionId]:205`) — my earlier probe missed the floor plan only
because it searched for `.floor-plan-*` classes this migration had already removed.

**Floor-plan manager — verified on `/properties/[id]`:** all three converted Cards
present ("Building-wide floor plan", "draft area review", "approved master areas"),
22px padding each, title 17px, scope switcher / Re-extract / Review 8 extracted
areas / Approve drafts / Add draft area all rendering, no collapsed containers, no
horizontal overflow. The specialized canvas surface is untouched, as intended.

**Area-evidence workspace:** rendered on `/inspections/[id]` (6 Cards, clean) but the
sampled inspection had **no captured areas**, so the tab list was empty
(`[role=tab]` = 0). The workspace's populated state is still unverified — it needs an
inspection with area evidence.

**Third Preflight regression found and fixed.** `CardTitle` (`h2`) and
`CardDescription` (`p`) carried the browser's default margins — 14.11px above every
card title — because `.panel h2 { margin: 0 }` / `.panel p` were deleted and the
primitives never reset them. This produced inconsistent spacing between cards, which
the visual spec explicitly bans. Added `m-0` to both. Confirmed live: titles now
`margin-top: 0px`.

That makes **three** regressions from the same root cause (upstream shadcn assumes
Preflight; this project omits it): control text colour, table element styling, and
now heading/paragraph margins. Any further primitive copied from the docs must be
checked for properties Preflight would have supplied.

### Filter-bar / form-control audit (added 2026-07-29)

Native `<select>` and `<input type=checkbox>` render with **OS chrome**, not the
design system — the grey pill dropdowns visible on Inspections, Assignments,
Technicians, Users and Settings. Preflight is omitted here, so nothing normalises
them. Component mapping per the shadcn docs:

| current | shadcn replacement | why |
|---|---|---|
| `<select>` + `<option>` (24, 15 files) | **Select** (`select.tsx`, installed) | fixed option list, no search |
| `<input type=checkbox>` (6 files) | **Checkbox** (`checkbox.tsx`, installed) | already present, unused |
| searchable `<select>` | **Combobox** (Popover + Command) | done — `searchable-select.tsx` |
| Roles permission pills | **Badge** | verify they use `status-badge`, not ad-hoc pills |
| Roles row actions (Edit/Delete) | **Button** + **AlertDialog** | destructive delete needs confirmation |

**`<select>` inventory:** `inspections/new` (5) · `assignments` (2) · `inspections` (2) ·
`inspection-charges` (2) · `inspection-workflow` (2) · `assignment-create-dialog` (2) ·
`settings` · `technicians` · `users` · `AreaEvidenceWorkspace` · `assignment-dialog` ·
`FloorPlanChecklist` · `inspection-actions-dialogs` · `inspection-comparison` ·
`inspection-review` (1 each).

**`type=checkbox` inventory:** `inspections` · `settings` · `users/[userId]` ·
`floor-plan-manager` · `role-editor-dialog` · `user-create-dialog`.

**Migration note:** Radix `Select` is **not** a native select — `onChange(e.target.value)`
becomes `onValueChange(value)`, and any react-hook-form `register()` must move to a
`Controller`. Check each call site's form wiring rather than swapping tags mechanically.
Also extend the `no-restricted-syntax` rule to ban raw `<select>` once conversion is done.

### Remaining

1. Routes still unseen: floor-plan manager, area-evidence workspace (the sampled
   inspection had no areas, so `[role=tab]` count was 0), charge-report, users,
   roles, assignments, technicians, profile.
2. Responsive `max-[560px]` Card padding never exercised — the Browser pane is fixed
   at 332x270 and `resize_window` did not change it.
3. Interaction states unverified: hover, focus rings, open dialogs/sheets/dropdowns,
   disabled controls. All checks were static computed styles on initial render.
4. **Lesson to apply to any remaining primitive:** upstream shadcn assumes Tailwind
   Preflight, which this project omits, and legacy unlayered element selectors
   silently outrank `@layer utilities`. Check both before trusting a primitive.

**Next command:** walk `/inspections/[id]` and the area-evidence workspace in both
themes, then re-run the layout-health probe.

### Status

| check | result |
|---|---|
| lint | **pass** |
| typecheck | **pass** |
| tests | **pass** — 17 files / 81 tests |
| build | **pass** — 20/20 routes |
