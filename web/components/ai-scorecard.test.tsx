import type { AiScorecard as Scorecard } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiScorecard } from './ai-scorecard';

/** How the AI's findings fared with the office, read from its decisions. */

const state = vi.hoisted(() => ({ data: null as Scorecard | null, days: [] as number[] }));

vi.mock('@/lib/queries', () => ({
  useAiScorecard: (days: number) => {
    state.days.push(days);
    return { data: state.data, isLoading: false, isError: false, error: null, refetch: vi.fn() };
  },
}));

const tally = (fields: Partial<Scorecard['totals']> = {}) => ({
  findings: 0,
  pending: 0,
  kept: 0,
  corrected: 0,
  rejected: 0,
  ...fields,
});

const CARD: Scorecard = {
  window: { days: 90, since: '2026-07-05T00:00:00.000Z', truncated: false },
  totals: tally({ findings: 24, pending: 4, kept: 10, corrected: 5, rejected: 5 }),
  bySource: {
    NARRATION: tally({ findings: 20, pending: 2, kept: 10, corrected: 4, rejected: 4 }),
    AI_VISION: tally({ findings: 4, pending: 2, corrected: 1, rejected: 1 }),
  },
  rejectReasons: { NORMAL_WEAR: 3, UNSPECIFIED: 2 },
  visual: {
    checked: 12,
    seen: 8,
    notSeen: 3,
    unclear: 1,
    notSeenRejected: 2,
    notSeenKept: 1,
    seenRejected: 1,
  },
  photos: { offered: 6, accepted: 4, allDismissed: 1 },
  timing: { narration: 20, withMoment: 17 },
  byVersion: [
    { ...tally({ findings: 14, kept: 7, corrected: 2, rejected: 3 }), promptVersion: '5', modelId: 'gpt-5.6-sol', guidanceVersion: 2 },
    { ...tally({ findings: 10, kept: 3, corrected: 3, rejected: 2 }), promptVersion: '4', modelId: 'gpt-5.6-sol', guidanceVersion: null },
  ],
};

beforeEach(() => {
  state.data = CARD;
  state.days = [];
});

describe('the AI scorecard', () => {
  it('shows the share of decided findings kept, corrected and rejected', () => {
    render(<AiScorecard />);

    expect(screen.getByText('Kept as written').nextSibling).toHaveTextContent('50%');
    expect(screen.getByText('10 of 20 decided')).toBeInTheDocument();
    expect(screen.getAllByText('Corrected')[0].nextSibling).toHaveTextContent('25%');
    expect(screen.getByText('Waiting for review').nextSibling).toHaveTextContent('4');
  });

  it('says why findings were rejected, including before reasons were asked', () => {
    render(<AiScorecard />);

    expect(screen.getByLabelText('Normal wear: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('No reason chosen: 2')).toBeInTheDocument();
  });

  it('compares the versions that wrote the findings, house rules included', () => {
    render(<AiScorecard />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      '5gpt-5.6-solVersion 21458%17%25%',
      '4gpt-5.6-solNone1038%38%25%',
    ]);
  });

  it('reads another period when asked', () => {
    render(<AiScorecard />);
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));

    expect(state.days.at(-1)).toBe(30);
  });

  it('says so when the AI made no findings', () => {
    state.data = { ...CARD, totals: tally(), byVersion: [] };
    render(<AiScorecard />);

    expect(screen.getByText('The AI made no findings in the last 90 days.')).toBeInTheDocument();
  });
});
