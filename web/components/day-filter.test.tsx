import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DayFilter } from './day-filter';

vi.mock('@/lib/clock', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  businessToday: () => '2026-10-07',
}));

/** One day at a time, as the timesheet picks it (the office, 2026-10-07). */
describe('DayFilter', () => {
  it('steps from the day shown, across a month end', () => {
    const onChange = vi.fn();
    render(<DayFilter onChange={onChange} value="2026-10-31" />);

    fireEvent.click(screen.getByRole('button', { name: 'The day after' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-11-01');
    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-30');
  });

  it('offers Today only away from today, and All dates only on a day', () => {
    const { rerender } = render(<DayFilter onChange={vi.fn()} value="2026-10-07" />);
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
    expect(screen.getByRole('button', { name: 'All dates' })).toBeInTheDocument();

    rerender(<DayFilter onChange={vi.fn()} value={null} />);
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'All dates' })).toBeNull();
  });

  it('steps from today when every date is shown', () => {
    const onChange = vi.fn();
    render(<DayFilter onChange={onChange} value={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'The day before' }));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-06');
  });
});
