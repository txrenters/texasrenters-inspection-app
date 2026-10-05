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
