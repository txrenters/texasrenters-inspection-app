import type { ExpoConfig } from 'expo/config';

const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

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
  slug: 'texasrenters-inspection',
  version: '0.1.0',
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
  //
  // The URL is derived from the EAS project rather than hard-coded, for the same
  // reason `extra.eas` is: the id is deployment configuration, not source. When
  // the variable is absent the key is omitted entirely and `expo-updates` simply
  // stays dormant — a local or unconfigured build is unaffected.
  ...(easProjectId ? { updates: { url: `https://u.expo.dev/${easProjectId}` } } : {}),
  // `fingerprint`, not `appVersion`. The policy decides which builds an update is
  // allowed to reach, and `appVersion` answers that with the marketing version —
  // which says nothing about the native layer. Add a native module without
  // touching `version` and `appVersion` would happily deliver JavaScript that
  // calls into it to a binary that does not contain it, crashing on launch, with
  // no way to recall the update. `fingerprint` hashes the native project itself,
  // so an update reaches exactly the builds that can run it and no others.
  runtimeVersion: { policy: 'fingerprint' },
  extra: {
    dataSource: process.env.EXPO_PUBLIC_ENABLE_DEMO_DATA === 'true' ? 'mock' : 'api',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
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
