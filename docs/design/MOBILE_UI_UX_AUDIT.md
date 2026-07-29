# Mobile UI/UX audit

## Scope

This audit covers all 23 Expo Router route files in `mobile-app/app`, the shared screen shell,
theme provider, state feedback, reusable controls, portal ownership, and the camera-first room
recording workflow. It preserves the REST boundary, durable offline queue, one-video-per-approved-
area rule, human approval of AI output, and latest-intent-wins state consistency.

## Root causes found

1. React Native Reusables and the pre-existing StyleSheet component layer were only partially
   integrated. Generated components used NativeWind's color mode while the app theme used a
   separate preference, so generated surfaces could remain light in dark mode.
2. The semantic theme did not satisfy the complete React Native Reusables token contract.
3. `AppScreen`, animated route wrappers, cards, headers, and status rows lacked consistent
   `minWidth: 0`, wrapping, and safe-area-aware bottom spacing. This caused compact-width clipping.
4. Loading feedback used a desktop-like card and wide skeletons rather than a compact mobile state.
5. Screens used a mix of direct `TextInput`, native `Modal`, hand-built controls, and generated
   primitives, which produced inconsistent focus, keyboard, and overlay behavior.
6. Search results waited for a debounced REST request before reflecting locally cached data.
7. Web preview animations requested the native driver and legacy pointer-event props, producing
   warnings unrelated to the real app workflow.
8. Physical-iPhone captures exposed problems that the earlier web preview missed: inspection rows
   lost their visual boundary, room rows became excessively tall, iOS back labels consumed header
   width, the Add Area dialog had no reliably reachable submit action, room actions were detached
   from evidence prerequisites, and the snapshot selector lacked a clear completion action.

## Corrections

- Completed the semantic NativeWind light/dark token set, including operational status colors.
- Synchronized NativeWind color mode with the persisted light/dark/system app preference.
- Kept one root `PortalHost`; generated `Dialog` and `AlertDialog` now own ordinary overlays.
- Adapted the existing public `AppButton`, `Card`, `StatusBadge`, `ProgressBar`, and confirmation
  API to the generated primitives so domain screens can migrate without behavior regressions.
- Added generated `Alert`, `Input`, `Textarea`, `Dialog`, and `AlertDialog`.
- Made the shared screen shell safe-area aware and compact-width safe.
- Rebuilt loading, empty, and error feedback around generated primitives and reduced-motion rules.
- Made cached inspection search immediate while retaining a 300 ms debounced server refresh.
- Migrated authentication, room notes, pet evidence, finding review, recording review, and manual
  area entry to generated form controls.
- Preserved the specialized full-screen camera implementation. Camera chrome, snapshot, record,
  finding marker, safe-area controls, and one-time guides are not ordinary form components.
- Disabled native-driver animation only on web and removed deprecated pointer-event composition.
- Replaced the inspection and room `ScrollView` maps with virtualized `FlatList` screen primitives.
- Consolidated each room into identity, one evidence summary, and one next action.
- Moved Add Area into its own keyboard-aware screen with a safe-area sticky submit action.
- Reworked room details around compact evidence state and disabled completion until a recording
  exists.
- Replaced the Snapshot Type choices with the official React Native Reusables radio-group
  primitive and explicit cancel/confirm actions.
- Made Settings theme selection interactive and changed backend status to a live reachability
  probe.
- Reduced the home empty state and separated quick actions into native rows; prioritized failed
  and active uploads ahead of waiting work.

## Route audit

| Route | Primary concern | Result |
|---|---|---|
| `app/index.tsx` | session routing | Preserved |
| `app/_layout.tsx` | theme, portal, providers | Repaired |
| `(auth)/_layout.tsx` | auth boundary | Verified |
| `(auth)/welcome.tsx` | compact header/actions | Repaired |
| `(auth)/login.tsx` | forms, alert feedback, keyboard flow | Repaired |
| `(auth)/change-password.tsx` | forms and compact header | Repaired |
| `(app)/_layout.tsx` | authenticated boundary | Verified |
| `(tabs)/_layout.tsx` | tab safe area and navigation | Verified |
| `(tabs)/dashboard.tsx` | hierarchy, empty state, quick actions | Repaired |
| `(tabs)/inspections.tsx` | virtualized list, compact cards, immediate search | Repaired |
| `(tabs)/uploads.tsx` | virtualized queue, state order, background refresh | Repaired |
| `(tabs)/settings.tsx` | radio theme control and backend reachability | Repaired |
| `inspections/[id]/index.tsx` | overview hierarchy and schedule wrapping | Repaired |
| `inspections/[id]/areas.tsx` | virtualized compact area list and sticky next action | Repaired |
| `inspections/[id]/areas/new.tsx` | keyboard-safe full-screen Add Area form | Added |
| `inspections/[id]/area/[areaId]/index.tsx` | hierarchy, evidence, notes, gated actions | Repaired |
| `.../record.tsx` | native camera, safe controls, snapshot type selection | Repaired custom surface |
| `.../review.tsx` | metadata form and queue action | Repaired |
| `.../processing.tsx` | durable queue/processing feedback | Verified |
| `inspections/[id]/findings.tsx` | filter and state feedback | Verified |
| `inspections/[id]/finding/[findingId].tsx` | review forms and responsive media | Repaired |
| `inspections/[id]/report.tsx` | report hierarchy and responsive rows | Verified |
| `properties/[id]/index.tsx` | property information layout | Verified |
| `properties/[id]/floor-plan.tsx` | informative missing-plan fallback | Verified |

## Intentional custom UI

The room recorder remains custom. A generated card/dialog composition would make a camera feel like
a web form and could push capture controls below the fold. The camera view owns the full screen,
applies top and bottom safe areas, overlays guidance only while needed, and leaves snapshot/record
controls permanently reachable. Ordinary preparation, cancellation, evidence metadata, review, and
status feedback use reusable primitives where appropriate.

## Accessibility and interaction

- Buttons expose role, label, disabled, and busy state.
- Progress exposes numeric accessibility values.
- Loader respects reduced motion.
- Errors provide a stable action instead of displaying transport details.
- Form labels and inputs retain explicit accessibility labels.
- Destructive confirmation remains open until the mutation confirms or the caller closes it, so an
  asynchronous rejection cannot silently disappear.
- Compact rows wrap rather than clipping labels or actions.

## Remaining device-only verification

Automated tests, web preview, and Expo export cannot prove physical iPhone camera permission,
microphone capture, haptics, keyboard avoidance, notch/Dynamic Island spacing, or background upload
resumption after an actual connectivity loss. Those checks remain in the device regression runbook
and must not be reported as passed until performed on hardware.
