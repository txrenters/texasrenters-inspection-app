import { describe, expect, it } from 'vitest';

import { resolveApiUrl } from '../src/http/api-url.js';

describe('shared REST API URL resolution', () => {
  it('appends a versioned path to a backend origin', () => {
    expect(resolveApiUrl('http://localhost:3000/', '/api/v1/auth/me')).toBe(
      'http://localhost:3000/api/v1/auth/me',
    );
  });
  it('does not duplicate an existing API version prefix', () => {
    expect(resolveApiUrl('http://localhost:3000/api/v1', '/api/v1/auth/me')).toBe(
      'http://localhost:3000/api/v1/auth/me',
    );
  });
  it('rejects paths outside the shared versioned API', () => {
    expect(() => resolveApiUrl('http://localhost:3000', '/admin/dashboard')).toThrow(
      'REST paths must start with /api/v1',
    );
  });
});
