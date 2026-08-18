import type { ExpoConfig } from 'expo/config';

/**
 * The EAS project, hardcoded on purpose.
 *
 * This is a public identifier, not a secret: it ships inside every binary as
 * `extra.eas.projectId` and again in the update URL, and it is fixed for the
 * life of the app. There is nothing to protect by holding it in the environment,
 * and holding it there cost more than it looked:
 *
 * - `expo` loads `.env.local`, but **`eas-cli` does not**. Every `eas build`,
 *   `submit`, `update` and `env` command needed the variable exported by hand,
 *   and forgetting it reports "EAS project not configured" — which sends you
 *   looking at the project link rather than at your shell.
 * - Worse, EAS Build re-evaluates this file on the build server. If the variable
 *   were missing there, `updates.url` would simply be absent and the build would
 *   ship unable to *ever* receive an over-the-air update, silently, with no way
 *   to correct it except another trip through review.
 *
 * The environment still wins if it is set, so a fork or a second project can
 * override it without editing source.
 */
const EAS_PROJECT_ID = 'ce9b1d5f-5851-4369-aa12-59b081b4556b';

const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || EAS_PROJECT_ID;

/**
 * The splash artwork's own background, sampled from the images themselves.
 *
 * Deliberately *not* the app tokens above. `resizeMode: 'contain'` letterboxes
 * the image, and the surrounding area is painted with `backgroundColor` — so a
 * value that does not match the artwork draws a visible band around it for the
 * whole of the launch. The dark pair was the worse of the two: navy artwork on
 * a near-black surround.
 *
 * The cost is a slight step at hand-off to the first screen instead of a hard
 * edge for the entire splash. Update these if the artwork is ever re-exported.
 */
const SPLASH_LIGHT_BACKGROUND = '#FFFFFF';
const SPLASH_DARK_BACKGROUND = '#0C1E42';

// The store identity, and the one part of this file that is effectively
// permanent: `bundleIdentifier` and `package` cannot be changed after the first
// submission without creating a separate listing and abandoning every install.
//
// These carried a `.v2` suffix and an "Inspect V2" display name until release
// preparation. That came from the period when two mobile packages existed side
// by side; `mobile-app` was deleted on 2026-07-31 and there has been one client
// since, so the suffix named a distinction that no longer exists — and it would
// have been visible on the technician's home screen forever.
//
// `inspection`, not `inspect`, to match the repository, the backend, and the
// web console's own branding.
const config: ExpoConfig = {
  name: 'TexasRenters Inspection',
  // Deliberately the odd one out, and **not** a typo to be tidied up.
  //
  // `slug` must equal the slug of the EAS project named by `extra.eas.projectId`
  // or every `eas` command refuses to run. That project was created as
  // `inspection-texas-renters`, and Expo fixes a project's slug at creation —
  // Project settings offers only a display name, so it cannot be renamed to
  // match the rest of this file. Changing it here is the only lever available.
  //
  // Nothing user-facing depends on it: the slug reaches no store listing, is not
  // the deep-link `scheme` below, and no application code reads it. Aligning it
  // with the others would cost a new EAS project, which means a new project id,
  // which means a new update URL compiled into every build.
  slug: 'inspection-texas-renters',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'texasrenters-inspection',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-notifications',
    'expo-video',
    [
      'expo-sensors',
      {
        motionPermission:
          'Allow TexasRenters Inspect to guide a slow clockwise room walkthrough.',
      },
    ],
    [
      'expo-splash-screen',
      {
        // Backgrounds match the app's own --background tokens, so the splash
        // dissolves into the first screen instead of flashing a different
        // colour. `dark` is honoured because userInterfaceStyle is 'automatic'.
        image: './assets/splash-light.png',
        resizeMode: 'contain',
        backgroundColor: SPLASH_LIGHT_BACKGROUND,
        dark: {
          // A separate asset, not a tint: the logo's "TEXAS" and ".com" are
          // dark navy and vanish on a dark background, while the green
          // "RENTERS" reads fine. See scripts/build-splash.mjs.
          image: './assets/splash-dark.png',
          backgroundColor: SPLASH_DARK_BACKGROUND,
        },
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission:
          'Allow TexasRenters Inspect to capture room-specific inspection evidence.',
        microphonePermission:
          'Allow TexasRenters Inspect to record technician narration.',
      },
    ],
  ],
  experiments: { typedRoutes: true },
  // Over-the-air updates. Without this block a bad production build can only be
  // corrected by building again and going back through App Review — days, during
  // which technicians in the field have a broken app and no way back.
  updates: { url: `https://u.expo.dev/${easProjectId}` },
  // `appVersion`, and the reason it is not `fingerprint` is worth recording,
  // because `fingerprint` is the better policy everywhere this repository is
  // not a monorepo.
  //
  // The policy decides which installed builds an update may reach. `appVersion`
  // answers with the marketing version above, which says nothing about the
  // native layer: add a native module without touching `version` and an update
  // can deliver JavaScript calling into it to a binary that does not contain it.
  // `fingerprint` avoids that by hashing the native project instead — and fails
  // here. This is an npm workspace, so dependencies hoist to the repository root
  // and the hash covers `../node_modules/**`, which does not resolve identically
  // on EAS Build. The first Android build errored on exactly that:
  //
  //   Runtime version mismatch
  //     local 24c02f17d44e620326bbb1a446505da534096c4d
  //     EAS   f53870102006c9f0d57fb5314fbc1ebc1a041b50
  //
  // the whole difference being hoisted `@expo/config-plugins` files. A mismatch
  // is fatal, not a warning, so no build could complete at all.
  //
  // What this costs: `version` must be bumped whenever native code, a plugin or
  // a native dependency changes, or an update may reach a binary that cannot run
  // it. That is a discipline rather than a guarantee — see the README.
  runtimeVersion: { policy: 'appVersion' },
  extra: {
    dataSource: process.env.EXPO_PUBLIC_ENABLE_DEMO_DATA === 'true' ? 'mock' : 'api',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    eas: { projectId: easProjectId },
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.texasrenters.inspection',
    infoPlist: {
      // The app's only cryptography is the HTTPS it speaks to our own API, which
      // is exempt. Declaring that here answers Apple's export-compliance question
      // once, in the build; leaving it unset asks it again by hand on every
      // single upload, and an absent-minded "yes" commits the account to filing
      // encryption paperwork it does not owe.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      // The artwork's own navy, so nothing shows through where the launcher's
      // mask exposes background. Was the brand green, which framed the navy
      // foreground in a ring of a colour the icon does not otherwise use.
      backgroundColor: SPLASH_DARK_BACKGROUND,
    },
    package: 'com.texasrenters.inspection',
  },
  web: { bundler: 'metro' },
};

export default config;
