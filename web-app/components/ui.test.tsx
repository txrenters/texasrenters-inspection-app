import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoadingState, TableLoadingState } from './ui';

describe('LoadingState', () => {
  it('announces the current loading task and exposes a busy container', () => {
    const { container } = render(<LoadingState label="Loading operational metrics…" />);

    expect(
      screen.getByRole('status', { name: 'Loading operational metrics…' }),
    ).toBeInTheDocument();
    expect(screen.getByText('TEXASRENTERS')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});

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
