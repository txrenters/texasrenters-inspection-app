import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type DataSource = 'mock' | 'api';

const demoDataEnabled = process.env.EXPO_PUBLIC_ENABLE_DEMO_DATA === 'true';
const configuredApiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim() || null;
// On networks with wireless client isolation the phone can never reach the dev
// machine's LAN IP; `adb reverse tcp:3000 tcp:3000` tunnels localhost over USB
// instead, so this flag keeps localhost as the primary API host on-device.
// adb reverse exists only on Android — on iOS "localhost" is the phone itself,
// so the preference must never apply there (use Expo tunnel mode instead).
const adbReverseEnabled =
  process.env.EXPO_PUBLIC_USE_ADB_REVERSE === 'true' && Platform.OS === 'android';
const apiBaseUrls = resolveDeviceApiBaseUrls(
  configuredApiBaseUrl,
  Constants.expoConfig?.hostUri,
  Platform.OS,
  process.env.EXPO_PUBLIC_DEV_LAN_API_BASE_URL?.trim() || null,
  adbReverseEnabled,
);
const apiBaseUrl = apiBaseUrls[0] ?? null;
const realtimeBaseUrls = resolveRealtimeBaseUrls(apiBaseUrls);
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || null;

export function resolveDeviceApiBaseUrl(
  baseUrl: string | null,
  metroHostUri: string | undefined,
  platform: string,
) {
  if (!baseUrl || platform === 'web' || !metroHostUri) return baseUrl;
  try {
    const apiUrl = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname)) return baseUrl;
    const metroHost = extractMetroHost(metroHostUri);
    if (!metroHost) return baseUrl;
    if (isExpoTunnelHost(metroHost)) {
      apiUrl.protocol = 'https:';
      apiUrl.hostname = metroHost;
      apiUrl.port = '';
      return apiUrl.toString().replace(/\/$/, '');
    }
    if (!isPrivateNetworkHost(metroHost)) return baseUrl;
    apiUrl.hostname = metroHost;
    return apiUrl.toString().replace(/\/$/, '');
  } catch {
    return baseUrl;
  }
}

export function extractMetroHost(hostUri: string) {
  const value = hostUri.trim();
  if (!value) return null;
  try {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    return new URL(normalized).hostname || null;
  } catch {
    return null;
  }
}

export function resolveDeviceApiBaseUrls(
  baseUrl: string | null,
  metroHostUri: string | undefined,
  platform: string,
  lanFallbackUrl: string | null,
  preferLocalhost = false,
) {
  const primary = resolveDeviceApiBaseUrl(baseUrl, metroHostUri, platform);
  if (!primary || platform === 'web' || !isLocalApiUrl(baseUrl)) return primary ? [primary] : [];
  const fallback = normalizePrivateApiUrl(lanFallbackUrl);
  const localhost = preferLocalhost ? normalizeLocalApiUrl(baseUrl) : null;
  return [
    ...new Set([localhost, primary, fallback].filter((value): value is string => Boolean(value))),
  ];
}

function normalizeLocalApiUrl(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isLocalApiUrl(value: string | null) {
  if (!value) return false;
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function normalizePrivateApiUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !isPrivateNetworkHost(url.hostname))
      return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isExpoTunnelHost(host: string) {
  return host.endsWith('.exp.direct') || host.endsWith('.expo.dev');
}

export function resolveRealtimeBaseUrls(baseUrls: readonly string[]) {
  return [
    ...new Set(
      baseUrls.flatMap((baseUrl) => {
        try {
          const url = new URL(baseUrl);
          if (isExpoTunnelHost(url.hostname)) return [];
          url.pathname = '';
          url.search = '';
          url.hash = '';
          return [url.toString().replace(/\/$/, '')];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

export function resolveEasProjectId(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const projectId = candidate.trim();
    if (projectId) return projectId;
  }
  return undefined;
}

function isPrivateNetworkHost(host: string) {
  if (host.endsWith('.local')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254)
  );
}

export const environment = {
  dataSource: (demoDataEnabled ? 'mock' : 'api') as DataSource,
  apiBaseUrl,
  apiBaseUrls,
  realtimeBaseUrls,
  supabaseUrl,
  enableTestVideoPicker: process.env.EXPO_PUBLIC_ENABLE_TEST_VIDEO_PICKER === 'true',
} as const;

export const isDemoMode = environment.dataSource === 'mock';
