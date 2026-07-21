import type { ExpoConfig } from 'expo/config';

const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim();

const config: ExpoConfig = {
  name: 'Texas Renters Inspection',
  slug: 'texasrenters-inspection',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'texasrenters-inspect',
  userInterfaceStyle: 'automatic',
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-notifications',
    'expo-video',
    [
      'expo-camera',
      {
        cameraPermission:
          'Allow Texas Renters Inspection to record room-specific inspection videos.',
        microphonePermission: 'Allow Texas Renters Inspection to record technician narration.',
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: {
    dataSource: process.env.EXPO_PUBLIC_ENABLE_DEMO_DATA === 'true' ? 'mock' : 'api',
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  ios: { supportsTablet: true, bundleIdentifier: 'com.texasrenters.inspection' },
  android: { package: 'com.texasrenters.inspection' },
  web: { bundler: 'metro' },
};

export default config;
