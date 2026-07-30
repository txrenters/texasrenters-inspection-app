import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeaderClocks } from './header-clocks';

/** Timer callbacks set React state, so the flush has to happen inside act. */
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

afterEach(() => {
  vi.useRealTimers();
});

/** 2026-07-30 17:40 UTC — Manila is already Friday, Texas is still Thursday. */
const ACROSS_MIDNIGHT = new Date('2026-07-30T17:40:00Z');

describe('HeaderClocks', () => {
  it('shows both offices with their own time and day', () => {
    vi.useFakeTimers({ now: ACROSS_MIDNIGHT });
    render(<HeaderClocks />);

    expect(screen.getByText('Manila')).toBeInTheDocument();
    expect(screen.getByText('Texas')).toBeInTheDocument();
    expect(screen.getByText('1:40 AM')).toBeInTheDocument();
    expect(screen.getByText('12:40 PM')).toBeInTheDocument();
    expect(screen.getByText(/Fri, Jul 31/)).toBeInTheDocument();
    expect(screen.getByText(/Thu, Jul 30/)).toBeInTheDocument();
  });

  it('labels each clock with a spoken description rather than leaving it to the visuals', () => {
    vi.useFakeTimers({ now: ACROSS_MIDNIGHT });
    render(<HeaderClocks />);

    expect(
      screen.getByRole('group', { name: /Manila, Philippines: 1:40 AM/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: /Texas, United States: 12:40 PM/ }),
    ).toBeInTheDocument();
  });

  it('is not a live region, so a screen reader does not announce every minute', () => {
    vi.useFakeTimers({ now: ACROSS_MIDNIGHT });
    const { container } = render(<HeaderClocks />);
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('advances when the minute rolls over', () => {
    vi.useFakeTimers({ now: new Date('2026-07-30T17:40:30Z') });
    render(<HeaderClocks />);
    expect(screen.getByText('12:40 PM')).toBeInTheDocument();

    // 29s short of the boundary: still 12:40, so the timer must not fire early.
    advance(29_000);
    expect(screen.getByText('12:40 PM')).toBeInTheDocument();

    advance(1_000);
    expect(screen.getByText('12:41 PM')).toBeInTheDocument();
  });

  it('stops ticking once unmounted', () => {
    vi.useFakeTimers({ now: ACROSS_MIDNIGHT });
    const { unmount } = render(<HeaderClocks />);
    unmount();
    // A surviving timer would call setState on an unmounted component.
    expect(() => advance(300_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
