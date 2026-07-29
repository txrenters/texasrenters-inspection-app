import type { ExpoConfig } from 'expo/config';

const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

const config: ExpoConfig = {
  name: 'TexasRenters Inspect V2',
  slug: 'texasrenters-inspect-v2',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'texasrenters-inspect-v2',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-notifications',
    'expo-video',
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        resizeMode: 'contain',
        backgroundColor: '#145347',
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
    bundleIdentifier: 'com.texasrenters.inspect.v2',
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#145347',
    },
    package: 'com.texasrenters.inspect.v2',
  },
  web: { bundler: 'metro' },
};

export default config;
