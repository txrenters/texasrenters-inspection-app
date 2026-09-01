import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAdminMutations } from './queries';

/**
 * What the console actually puts on the wire when an area is edited.
 *
 * These mutations build their request body field by field rather than
 * forwarding the caller's object, so a field the editor collects and the body
 * does not name is dropped in silence — no type error, no console error, no
 * failed request. The box ticked, the PATCH going out without it, the server
 * answering 200 having changed nothing, and the box clear again after the next
 * refetch.
 *
 * That happened to `hasAirConditioning`, which is gone now — HVAC no longer
 * scopes by area. These assertions moved to `isRequired`, which carries exactly
 * the same risk: it is a boolean the editor collects, and `false` and "absent"
 * are different instructions to the server.
 */

const calls: Array<{ path: string; method?: string; body: Record<string, unknown> }> = [];

vi.mock('@/lib/api', () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    });
    return { id: 'area-1', updatedAt: '2026-08-15T00:00:00.000Z' };
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mutations() {
  return renderHook(() => useAdminMutations(), { wrapper }).result;
}

describe('editing a property area', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('sends every field the editor collects', async () => {
    const result = mutations();

    result.current.updatePropertyArea.mutate({
      propertyId: 'property-1',
      areaId: 'area-1',
      floorName: '2nd floor',
      name: 'Hall',
      inspectionOrder: 1,
      isRequired: true,
      expectedUpdatedAt: '2026-08-14T00:00:00.000Z',
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toContain('/property-areas/area-1');
    expect(calls[0]!.body).toMatchObject({
      floorName: '2nd floor',
      name: 'Hall',
      inspectionOrder: 1,
      isRequired: true,
    });
  });

  it('sends a box being cleared, not just being set', async () => {
    // `false` and "absent" are different instructions to the server, and a
    // truthy check in the body would make the box impossible to untick.
    const result = mutations();

    result.current.updatePropertyArea.mutate({
      propertyId: 'property-1',
      areaId: 'area-1',
      isRequired: false,
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.isRequired).toBe(false);
  });

  it('carries the flags when an area is created', async () => {
    const result = mutations();

    result.current.createPropertyArea.mutate({
      propertyId: 'property-1',
      floorName: 'Ground Floor',
      name: 'Utility room',
      inspectionOrder: 3,
      isRequired: true,
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({ name: 'Utility room', isRequired: true });
  });
});
