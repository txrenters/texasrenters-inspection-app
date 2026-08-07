import Constants from 'expo-constants';
import { Platform } from 'react-native';

export type DataSource = 'mock' | 'api';
export type AppEnvironment = 'development' | 'remote-beta' | 'production';

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
const appEnv = (process.env.EXPO_PUBLIC_APP_ENV?.trim() || 'development') as AppEnvironment;

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
    // A legacy Expo-hosted tunnel is not a NestJS reverse proxy. The active
    // remote-beta workflow injects its Docker/ngrok gateway as baseUrl before
    // this resolver runs, so it does not enter this localhost rewrite branch.
    if (isExpoTunnelHost(metroHost)) return null;
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
  if (platform === 'web' || !isLocalApiUrl(baseUrl)) return primary ? [primary] : [];
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

/**
 * Reject, at startup, an API address the phone cannot actually reach.
 *
 * Remote beta and production both put the backend on the public internet with
 * the device on cellular data, so an address that merely works on the
 * developer's desk is a silent failure: the phone resolves `localhost` to
 * *itself* and every request dies with a confusing network error.
 *
 * Production is held to the same rules, and for one additional reason.
 * `EXPO_PUBLIC_*` values are inlined at build time, so a release built without
 * them carries no API address at all — it installs, launches, signs nobody in,
 * and reports only network errors. Production used to be exempt from this check
 * entirely, which meant the one build nobody can hot-fix was the only one
 * nothing verified.
 *
 * Development is deliberately exempt: localhost, LAN addresses and adb-reverse
 * tunnels are all correct there.
 */
export function validateApiBaseUrl(
  value: string | null,
  env: AppEnvironment,
): { ok: true } | { ok: false; reason: string } {
  if (env === 'development') return { ok: true };
  if (!value)
    return {
      ok: false,
      reason:
        env === 'production'
          ? 'This build carries no EXPO_PUBLIC_API_BASE_URL. It was built without the production environment variables — set them on the EAS build profile and rebuild.'
          : 'EXPO_PUBLIC_API_BASE_URL is required in remote-beta mode. Re-run the start helper.',
    };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `EXPO_PUBLIC_API_BASE_URL is not a valid URL: ${value}` };
  }

  if (url.protocol !== 'https:')
    return {
      ok: false,
      reason: `${env === 'production' ? 'Production' : 'Remote beta'} requires HTTPS. Received ${url.protocol}//`,
    };

  const host = url.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host))
    return {
      ok: false,
      reason: `"${host}" is the phone itself, not the server. Use the public API host.`,
    };
  // Compose service names resolve only inside the Docker network.
  if (!host.includes('.'))
    return { ok: false, reason: `"${host}" looks like a Docker service name, not a public host.` };
  if (isPrivateNetworkHost(host))
    return {
      ok: false,
      reason: `"${host}" is a private LAN address and is unreachable over cellular data.`,
    };
  if (host.startsWith('fd') || host.startsWith('fc') || host.startsWith('fe80'))
    return { ok: false, reason: `"${host}" is a private IPv6 address.` };

  return { ok: true };
}

const apiUrlCheck = validateApiBaseUrl(apiBaseUrl, appEnv);
if (!apiUrlCheck.ok && __DEV__) {
  // Loud in development, non-fatal: a tester mid-inspection must not lose
  // captured work because the tunnel URL went stale. In a release build the
  // reason is still carried on `environment` and surfaced by Diagnostics, which
  // is the only channel a technician in the field has.
  console.error(`[config] ${apiUrlCheck.reason}`);
}

export const environment = {
  appEnv,
  apiBaseUrlError: apiUrlCheck.ok ? null : apiUrlCheck.reason,
  dataSource: (demoDataEnabled ? 'mock' : 'api') as DataSource,
  apiBaseUrl,
  apiBaseUrls,
  realtimeBaseUrls,
  enableTestVideoPicker: process.env.EXPO_PUBLIC_ENABLE_TEST_VIDEO_PICKER === 'true',
} as const;

export const isDemoMode = environment.dataSource === 'mock';
