import type { TruckKeepLevels } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeepLevelsDialog } from './keep-levels';

/** Keep at least on a truck (2026-11-24). Every item and place invented. */

const hooks = vi.hoisted(() => ({ useTruckKeepLevels: vi.fn(), useTruckKeepEdits: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);

const LEVELS: TruckKeepLevels = {
  place: { id: 'place-van', name: 'Truck 1', code: 'TRK-01' },
  levels: [
    { itemId: 'item-filter', code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'each', keepAtLeast: 6, onHand: 2 },
    { itemId: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each', keepAtLeast: null, onHand: 3 },
  ],
};
let save: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null };

beforeEach(() => {
  save = { mutateAsync: vi.fn(async () => LEVELS), isPending: false, error: null };
  hooks.useTruckKeepLevels.mockReturnValue({ isError: false, data: LEVELS });
  hooks.useTruckKeepEdits.mockReturnValue({ save });
});

describe('keep at least on a truck', () => {
  // Production, 2026-11-24: with no item codes it opened onto an empty table.
  it('says there are no item codes yet, rather than showing an empty table', () => {
    hooks.useTruckKeepLevels.mockReturnValue({ isError: false, data: { ...LEVELS, levels: [] } });
    render(<KeepLevelsDialog onClose={vi.fn()} placeId="place-van" />);
    expect(screen.getByText(/There are no item codes yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says when nothing matches what was typed', () => {
    render(<KeepLevelsDialog onClose={vi.fn()} placeId="place-van" />);
    fireEvent.change(screen.getByLabelText('Find an item'), { target: { value: 'sprayer' } });
    expect(screen.getByText('No item matches that.')).toBeTruthy();
  });

  it('shows what is kept and on hand, marks what is running low, and saves only what changed', async () => {
    render(<KeepLevelsDialog onClose={vi.fn()} placeId="place-van" />);
    const table = screen.getByRole('table', { name: 'What is kept on the truck' });
    expect(within(table).getByRole('row', { name: /FLT-16251/ }).textContent).toContain('Running low');
    expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Keep at least of BAT-9V'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Keep at least of FLT-16251'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() =>
      expect(save.mutateAsync).toHaveBeenCalledWith({
        placeId: 'place-van',
        input: {
          levels: [
            { itemId: 'item-filter', keepAtLeast: null },
            { itemId: 'item-battery', keepAtLeast: 4 },
          ],
        },
      }),
    );
  });

  it('says so for a number it cannot keep, and saves nothing', () => {
    render(<KeepLevelsDialog onClose={vi.fn()} placeId="place-van" />);
    fireEvent.change(screen.getByLabelText('Keep at least of BAT-9V'), { target: { value: 'six' } });
    expect(screen.getByText('Keep at least of BAT-9V is a whole number up to 10,000, or empty for none.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
