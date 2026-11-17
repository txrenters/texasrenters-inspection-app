import { fireEvent, render, screen } from '@testing-library/react';
import type { RevenueClearedCell } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClearedCellsDialog, shownValue } from './cleared-cells-dialog';

/** Cells cleared by mistake, put back from the history (2026-11-17). Everything invented. */

const state = vi.hoisted(() => ({ cells: [] as RevenueClearedCell[], restore: vi.fn() }));
vi.mock('@/lib/actual-vs-budget-queries', () => ({
  useClearedCells: () => ({ isPending: false, isError: false, data: { cells: state.cells }, refetch: vi.fn() }),
  useRestoreClearedCells: () => ({ mutate: state.restore, isPending: false }),
}));

const cell = (over: Partial<RevenueClearedCell>): RevenueClearedCell => ({
  id: 'audit-1:driveTime',
  at: '2026-11-17T18:01:00.000Z',
  by: 'Office Coordinator',
  where: 'Moses Rodriguez · 2026-11-17 · 17518 Autumn Hills Dr · job 20373',
  field: 'driveTime',
  lost: '10–20 min',
  saved: 'estimatedBudgetCents = 7899',
  certain: true,
  ...over,
});

beforeEach(() => {
  state.restore.mockReset();
  state.cells = [
    cell({}),
    cell({ id: 'audit-1:estimatedBudgetCents', field: 'estimatedBudgetCents', lost: '7899' }),
    cell({ id: 'audit-4:day|moses|2026-11-17:dailyRemarks', field: 'dailyRemarks', lost: 'Completed 8 TBPs', by: 'Excel', certain: false, saved: null }),
  ];
});

describe('the cleared cells', () => {
  it('shows each with what it held, as its sheet shows it, and ticks those certainly cleared by mistake', () => {
    render(<ClearedCellsDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('10–20 min')).toBeTruthy();
    expect(screen.getByText('78.99')).toBeTruthy();
    expect(screen.getByText('Emptied in Excel')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false']);
    expect(screen.getByRole('button', { name: 'Put back 2 cells' })).toBeTruthy();
  });

  it('puts back the ticked ones, one more ticked by the office', () => {
    render(<ClearedCellsDialog canManage onClose={() => undefined} />);
    fireEvent.click(screen.getAllByRole('checkbox')[2]!);
    fireEvent.click(screen.getByRole('button', { name: 'Put back 3 cells' }));
    expect(state.restore).toHaveBeenCalledWith(['audit-1:driveTime', 'audit-1:estimatedBudgetCents', 'audit-4:day|moses|2026-11-17:dailyRemarks'], expect.anything());
  });

  it('says so when there is nothing to put back', () => {
    state.cells = [];
    render(<ClearedCellsDialog canManage onClose={() => undefined} />);
    expect(screen.getByText('Nothing to put back.')).toBeTruthy();
  });

  it('shows money, hours, yes or no and days as the sheets do', () => {
    expect([shownValue('laborCents', '21000'), shownValue('workSeconds', '30300'), shownValue('workComplete', 'true'), shownValue('rescheduleOn', '2026-11-20')]).toEqual([
      '210.00', '8h 25m', 'Yes', '11/20/2026',
    ]);
  });
});
