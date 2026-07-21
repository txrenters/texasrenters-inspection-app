const API_VERSION_PREFIX = '/api/v1';

export function resolveApiUrl(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, '');
  if (!normalizedBase) throw new Error('A backend API base URL is required.');
  if (!path.startsWith(`${API_VERSION_PREFIX}/`) && path !== API_VERSION_PREFIX)
    throw new Error(`REST paths must start with ${API_VERSION_PREFIX}.`);
  return normalizedBase.endsWith(API_VERSION_PREFIX)
    ? `${normalizedBase}${path.slice(API_VERSION_PREFIX.length)}`
    : `${normalizedBase}${path}`;
}
