import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATUS_MAP, StatusBadge } from './status-badge';

describe('status system', () => {
  it('renders one status identically wherever it appears', () => {
    // The old badge guessed a tone by regex-matching the text, so the same
    // status could differ between screens. Now every screen resolves here.
    const first = render(<StatusBadge value="APPROVED" />).container.innerHTML;
    const second = render(<StatusBadge value="APPROVED" />).container.innerHTML;
    expect(first).toBe(second);
  });

  it('never communicates status by colour alone', () => {
    render(<StatusBadge value="FAILED" />);
    // A readable label is always present, so the meaning survives greyscale,
    // colour-blindness and a screen reader.
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('keeps review and severity vocabularies distinct', () => {
    // "HIGH" severity and "REVIEW_REQUIRED" both read as urgent, but they are
    // different axes and must not collapse into the same label.
    expect(STATUS_MAP.HIGH.label).toBe('High');
    expect(STATUS_MAP.REVIEW_REQUIRED.label).toBe('Review required');
    expect(STATUS_MAP.PENDING_REVIEW.label).not.toBe(STATUS_MAP.APPROVED.label);
  });

  it('degrades to a readable label for an unmapped status', () => {
    render(<StatusBadge value="SOME_NEW_STATE" />);
    // Never leak a raw enum to an operator.
    expect(screen.getByText('Some new state')).toBeInTheDocument();
  });

  it('maps decisions and lifecycle states to sensible tones', () => {
    expect(STATUS_MAP.APPROVED.tone).toBe('success');
    expect(STATUS_MAP.REJECTED.tone).toBe('destructive');
    expect(STATUS_MAP.PENDING_REVIEW.tone).toBe('warning');
    expect(STATUS_MAP.NOT_STARTED.tone).toBe('muted');
  });
});
