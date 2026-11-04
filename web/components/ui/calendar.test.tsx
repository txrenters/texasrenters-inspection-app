import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Calendar } from './calendar';

/**
 * Every calendar's today is the field's (the office, 2026-10-06: "we are not
 * using Manila time"). Left to the browser it is the reader's, and a Manila
 * morning is still the evening before in Texas.
 */
describe('a calendar’s today', () => {
  afterEach(() => vi.useRealTimers());

  it('is today in Texas, whoever is reading', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 9 PM on 5 October in Houston; 10 AM on the 6th in Manila.
    vi.setSystemTime(new Date('2026-10-06T02:00:00.000Z'));
    const { container } = render(<Calendar mode="single" />);

    const today = container.querySelector('[data-today="true"]');
    expect(today?.textContent).toBe('5');
  });
});

/**
 * The month arrows (the office, 2026-11-05: "when I click the next to go to the
 * next month it is not functioning for a few second or a minute"). The month's
 * caption is positioned and comes after the arrows, so without a stacking order
 * of their own it was painted over them, and a click on an arrow's middle
 * landed on the caption. The browser check is the proof; this keeps the order.
 */
describe('a calendar’s month arrows', () => {
  it('sit above the month caption, inside the calendar', () => {
    const { container, getByRole } = render(<Calendar mode="single" />);

    for (const name of [/previous month/i, /next month/i]) {
      const arrow = getByRole('button', { name });
      expect(arrow.className).toMatch(/\babsolute\b/);
      expect(arrow.className).toMatch(/\bz-10\b/);
    }
    expect(container.firstElementChild?.className).toMatch(/\brelative\b/);
  });

  it('move the month on a click', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T18:00:00.000Z'));
    const { getByRole, findByText } = render(<Calendar mode="single" />);

    getByRole('button', { name: /next month/i }).click();
    expect(await findByText('December 2026')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
