import { describe, expect, it } from 'vitest';

import { queryString } from './api';

describe('admin API query serialization', () => {
  it('keeps explicit false values and omits empty filters', () => {
    expect(queryString({ page: 2, active: false, search: '', technicianId: undefined })).toBe(
      '?page=2&active=false',
    );
  });

  it('encodes user-entered filters', () => {
    expect(queryString({ search: 'Oak & Main' })).toBe('?search=Oak+%26+Main');
  });
});
