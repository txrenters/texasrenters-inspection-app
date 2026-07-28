# Mobile — React Native Reusables Migration Tracker

Authoritative continuation state. Resume by reading this file, checking `git status`, then
starting at **§20 Exact next step**.

## 1. Expo SDK version

**54.0.36** · React Native **0.81.5**.

## 2. Package manager

**pnpm** (workspace root lockfile; `mobile-app` is a workspace package). Do not switch.

## 3. Styling system found

**None.** This is the decisive finding.

- No `nativewind`, no `uniwind`, no `tailwindcss`, no `styled-components`.
- **24 files use `StyleSheet.create`.**
- No `global.css`, no `tailwind.config.*`, no `components.json`, no `components/ui/`.
- Icons: `@expo/vector-icons` — **not** `lucide-react-native`.

React Native Reusables requires NativeWind or Uniwind. Neither exists, so this is **not** a
component-swap migration like the web app's. The styling engine has to be installed and the
entire StyleSheet codebase re-expressed in utility classes before RNR components can be
adopted meaningfully.

Present and usable: `react-native-reanimated`, `react-native-safe-area-context`,
`react-native-screens`.

## 4. React Native Reusables setup status

- [x] **Foundation installed and verified.** NativeWind is live; doctor detects it.

Installed (pinned, Expo-SDK-54 compatible):

| package | version | note |
|---|---|---|
| nativewind | 4.2.6 | |
| tailwindcss | **3.4.19** | pinned to v3 — `expo install` resolved 4.3.3, which NativeWind 4 cannot use |
| react-native-css-interop | 0.2.6 | NativeWind runtime |
| react-native-worklets | 0.5.1 | required by reanimated 4 |
| class-variance-authority / clsx / tailwind-merge | ^0.7.1 / ^2.1.1 / ^2.6.0 | |
| tailwindcss-animate | ^1.0.7 | dev |
| @rn-primitives/portal | ^1.3.0 | |
| @rn-primitives/slot | ^1.5.2 | |

Files created / wired:

- `components.json` — **aliases point at `src/`**, because `tsconfig` maps `@/* → src/*`.
  Components therefore belong in **`src/components/ui/`**, not `components/ui/` as the brief
  assumed. Verified against the real alias.
- `global.css` — semantic tokens as HSL triples, derived from the existing
  `src/theme/colors.ts` palette (light + dark) so that palette stays authoritative. Includes
  the inspection-specific `success` / `warning` / `info` pairs and `chart-1..5`.
- `tailwind.config.js` — nativewind preset, `darkMode: 'class'`, content globs for `app/` and
  `src/`, semantic colour mapping.
- `babel.config.js` — `jsxImportSource: 'nativewind'` + `nativewind/babel`.
- `metro.config.js` — `withNativeWind(config, { input: './global.css', inlineRem: 16 })`
  applied **last**, so the existing pnpm `_tmp_` blockList, the zustand resolver shim and the
  `/api/v1` → :3000 proxy all survive.
- `app/_layout.tsx` — `import '../global.css'` and one `<PortalHost />` inside `AppProviders`.
- `src/lib/utils.ts` (`cn`) and `src/lib/theme.ts` (`NAV_THEME`).

## 5. CLI doctor result

- [~] Run successfully. Earlier "hang" was the npx download, not the command; `--log-level`
  must precede the subcommand.

Passing: expo 54.0.36 · reanimated 4.1.7 · safe-area-context 5.6.2 · Root Layout · Babel
Config · Metro Config · **Styling Library: Nativewind** · css import · PortalHost · Utils.

Remaining: **1** — `Theme → At least one of the color variables is missing`. All 24 semantic
vars plus `chart-1..5` and `radius` are present in both `:root` and `.dark:root`, so the
specific name it wants is unidentified. The CLI ships as a single bundled `bin.cjs` and has no
`--fix`, so the expected list could not be extracted. **Not yet resolved — do not treat as
cosmetic without checking.**

## 6. Components already installed

**None.** `src/components/ui/` does not exist yet.

### [!] Blocker: pnpm hoisted-linker race defeats the component installer

Every `add` attempt fails the same way. The RNR CLI shells out to
`pnpm dlx shadcn@latest add <registry urls>`; shadcn installs peer deps **before** writing
files; that install hits `ERR_PNPM_ENOENT` on this workspace's hoisted linker
(`node_modules/<pkg>_tmp_<pid>_<n>`), and the command aborts before any component is written.

Confirmed, not assumed:
- Pre-installing `@rn-primitives/slot` so the step would be a no-op did **not** help.
- Plain `pnpm install` reconciles only after repeated targeted removals — it cycles
  `+8 -103` and needs 4–8 retries to converge.

Workarounds to try next, in order:
1. `npx shadcn@4.15.0 add <urls>` — the CLI itself suggests this older version.
2. Set `node-linker=isolated` for `mobile-app` only, or run the add with
   `--package-manager npm` if supported, to sidestep the hoisted reconcile.
3. Last resort: fetch each registry JSON and write the component files directly, then add the
   listed deps manually. This is a documented registry format, not "copying random snippets" —
   but only after 1 and 2 fail.

## 7. Legacy components discovered

`src/components/` — `AppScreen` · `BrandLogo` · `ConnectedInspectionCard` · `FeatureCards` ·
`NetworkBanner` · `ScreenStates` · `UploadQueueRunner` · `motion` · **`ui.tsx`** (the current
hand-built primitive set — the direct analogue of what RNR replaces).

## 8. Screens discovered (23 route files)

Auth: `welcome` · `login` · `change-password` · `(auth)/_layout`
Tabs: `dashboard` · `inspections` · `uploads` · `settings` · `(tabs)/_layout`
Inspection: `[inspectionId]/index` · `areas` · `findings` · `finding/[findingId]` · `report`
Area: `area/[areaId]/index` · `record` · `review` · `processing`
Property: `properties/[propertyId]/index` · `floor-plan`
Root: `app/index` · `(app)/_layout`

## 9. Screen-by-screen migration status

- [ ] All 23 — not started.

## 10–19. Status

| item | state |
|---|---|
| Expo Go compatibility | [ ] not assessed |
| PortalHost | [ ] not configured |
| Theme tokens | [ ] not created |
| Accessibility | [ ] not audited |
| Physical iPhone test | [ ] not run |
| Lint | not run this session |
| Typecheck | not run this session |
| Tests | not run this session |
| Expo validation | not run this session |

## 20. Exact next step (superseded — see below)

**Nothing has been modified.** No dependency installed, no file changed.

### Sequenced plan

1. **Get the doctor to run.** `pnpm add -D @react-native-reusables/cli` inside `mobile-app`,
   then `pnpm exec @react-native-reusables/cli doctor --log-level all`. The `npx` path hangs
   here.
2. **Install the styling engine** — NativeWind v4 matched to Expo SDK 54, plus `tailwindcss`,
   `metro.config.js` wiring, `global.css`, `babel.config.js` preset, and
   `inlineRem: 16`. **Verify against Expo Go before anything else** — this touches Metro and
   Babel, which is exactly what can break the tunnel workflow the iOS beta depends on.
3. **Create `components.json`** with mobile aliases (`@/components`, `@/components/ui`,
   `@/lib`, `@/hooks`) — do not copy web-app paths.
4. **Define semantic tokens** in `global.css` mirroring the web token names, plus the
   inspection-specific set (offline, pendingSync, uploading, processing, needsReview,
   recording, captureGuide).
5. **CLI-add** `text`, `icon`, `button` first; verify one screen end-to-end on a physical
   iPhone before adding more.
6. Add portal components (`dialog`, `select`, `alert-dialog`) and mount **one** `PortalHost`
   in `app/(app)/_layout.tsx`.
7. Migrate screens in the order in §32 of the brief, retiring `src/components/ui.tsx` last.

### Risk to flag before step 2

Adding NativeWind changes Metro and Babel configuration. The brief states the remote iOS beta
runs on **Expo Go over a Metro tunnel**, and that core inspection/recording/offline/upload
behaviour outranks decorative UI. Step 2 should be validated on a real device and committed
separately, so it can be reverted without unwinding component work.

**Next command:**
`cd mobile-app && pnpm add -D @react-native-reusables/cli && pnpm exec @react-native-reusables/cli doctor --log-level all`


---

## 21. Current state (authoritative)

**Workspace verified healthy after the install churn:** Prisma client intact, backend still
listening on :3000 (never interrupted — no `node_modules` wipe was performed), **web-app
typecheck passes**, **mobile-app typecheck passes**.

Changed so far: `mobile-app/{components.json, global.css, tailwind.config.js, babel.config.js,
metro.config.js, package.json}`, `mobile-app/app/_layout.tsx`,
`mobile-app/src/lib/{utils,theme}.ts`, root `pnpm-lock.yaml`.

**Not yet done:** zero components installed, zero screens migrated, `src/components/ui.tsx`
untouched, 24 `StyleSheet.create` files untouched.

**Untested:** the app has **not been booted since Babel and Metro changed**. That is the single
highest-risk item — those two files are what the Expo Go tunnel workflow depends on.

### Next commands

1. `cd mobile-app && pnpm start` — confirm Metro still boots and the tunnel works **before**
   anything else. Revert `babel.config.js` + `metro.config.js` if not.
2. `cd mobile-app && npx shadcn@4.15.0 add https://reactnativereusables.com/r/nativewind/text.json`
   — single component, older shadcn, to test the blocker fix in isolation.
3. On success, add `icon` and `button`, then migrate `app/(auth)/login.tsx` as the first screen.
