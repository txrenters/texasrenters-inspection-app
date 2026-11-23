import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkOrderMatchingActions } from './work-order-matching-actions';

/**
 * Skill matching on the Work orders page: whether it is still a trial, loading
 * the Scope of Work sheet after showing who it found, and checking the work
 * orders already waiting. Names invented.
 */

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api,
}));
const granted = vi.hoisted(() => ({ keys: new Set<string>() }));
vi.mock('@/lib/auth', () => ({
  usePermissions: () => ({ has: (key: string) => granted.keys.has(key) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkOrderMatchingActions />
    </QueryClientProvider>,
  );
}

describe('WorkOrderMatchingActions', () => {
  beforeEach(() => {
    api.mockReset();
    granted.keys = new Set(['technicians:skills']);
  });

  it('shows nothing to someone who does not decide who is qualified', () => {
    granted.keys = new Set();
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
    expect(api).not.toHaveBeenCalled();
  });

  it('says when matching only suggests', async () => {
    api.mockResolvedValueOnce({ live: false });
    mount();
    expect(await screen.findByText('Auto-assign trial: suggests only')).toBeInTheDocument();
  });

  it('shows who the sheet found before loading it, and loads only on confirm', async () => {
    api.mockImplementation(async (path: string, init?: { body?: string }) => {
      if (path.endsWith('/work-order-matching')) return { live: false };
      const apply = JSON.parse(init?.body ?? '{}').apply === true;
      return { applied: apply, skills: 105, marks: 306, found: ['Ana Tech'], missing: ['Ben Tech'] };
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /load skills sheet/i }));
    expect(await screen.findByText(/Ana Tech/)).toBeInTheDocument();
    expect(screen.getByText(/left out: Ben Tech/)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(
      '/api/v1/admin/work-order-matching/import-skills',
      expect.objectContaining({ body: JSON.stringify({ apply: false }) }),
    );
    fireEvent.click(screen.getByRole('button', { name: /load for 1 technician/i }));
    await vi.waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/admin/work-order-matching/import-skills',
        expect.objectContaining({ body: JSON.stringify({ apply: true }) }),
      ),
    );
  });
});
