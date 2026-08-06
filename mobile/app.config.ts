import type { ExpoConfig } from 'expo/config';

const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

/** `--background` from global.css, so splash and first paint agree. */
const LIGHT_BACKGROUND = '#FCFBF8';
const DARK_BACKGROUND = '#0A0F18';

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
        backgroundColor: LIGHT_BACKGROUND,
        dark: {
          // A separate asset, not a tint: the logo's "TEXAS" and ".com" are
          // dark navy and vanish on a dark background, while the green
          // "RENTERS" reads fine. See scripts/build-splash.mjs.
          image: './assets/splash-dark.png',
          backgroundColor: DARK_BACKGROUND,
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
  extra: {
    dataSource: process.env.EXPO_PUBLIC_ENABLE_DEMO_DATA === 'true' ? 'mock' : 'api',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.texasrenters.inspection',
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#145347',
    },
    package: 'com.texasrenters.inspection',
  },
  web: { bundler: 'metro' },
};

export default config;
