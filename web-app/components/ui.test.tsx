import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TableLoadingState } from './ui';

describe('TableLoadingState', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the branded loader first and transitions to a table-shaped skeleton', () => {
    vi.useFakeTimers();
    render(
      <TableLoadingState headers={['Property', 'Status']} rows={3} label="Loading properties" />,
    );

    expect(screen.getByRole('status', { name: 'Loading properties' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByRole('table', { name: 'Loading properties' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});
