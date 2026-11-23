import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkOrderCrewButton } from './work-order-crew-dialog';

/** Choosing which technicians work orders may be matched to. Names invented. */

const api = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const everyone = [
  { technicianId: 'tech-ana', displayName: 'Ana Tech', inCrew: true, skills: 40 },
  { technicianId: 'tech-ben', displayName: 'Ben Tech', inCrew: true, skills: 0 },
  { technicianId: 'tech-cal', displayName: 'Cal Tech', inCrew: true, skills: 12 },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrderCrewButton />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /matching crew/i }));
}

describe('WorkOrderCrewButton', () => {
  beforeEach(() => {
    api.mockReset();
    api.mockImplementation(async (_path: string, init?: { method?: string; body?: string }) =>
      init?.method === 'PUT' ? everyone : everyone,
    );
  });

  it('lists every technician with their skills, everyone considered while nobody is chosen', async () => {
    mount();
    expect(await screen.findByText('Ana Tech')).toBeInTheDocument();
    expect(screen.getByText('40 skills')).toBeInTheDocument();
    expect(screen.getByText('no skills yet')).toBeInTheDocument();
    expect(screen.getByText('Everyone is considered')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the technicians left ticked', async () => {
    mount();
    await screen.findByText('Ben Tech');
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(screen.getByText('2 of 3 considered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/api/v1/admin/work-order-matching/crew',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ technicianIds: ['tech-ana', 'tech-cal'] }) }),
      ),
    );
  });
});
