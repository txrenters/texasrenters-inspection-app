import type { AiEvaluationRun, AiEvaluationRunSummary } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiTestRuns } from './ai-test-runs';

/**
 * Test runs of the AI against the office's own decisions, compared side by
 * side before a change to the rules is saved.
 */

const state = vi.hoisted(() => ({
  runs: [] as AiEvaluationRunSummary[],
  detail: null as AiEvaluationRun | null,
}));

vi.mock('@/lib/queries', () => ({
  useAiEvaluations: () => ({
    data: state.runs,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAiEvaluation: (id: string | null) => ({
    data: id ? state.detail : undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const summary = (fields: Partial<AiEvaluationRunSummary>): AiEvaluationRunSummary => ({
  id: 'run-1',
  status: 'COMPLETED',
  error: null,
  guidanceVersion: null,
  houseRulesLength: 1240,
  promptVersion: '5',
  modelId: 'gpt-5.6-sol',
  recordingCount: 10,
  completedCount: 10,
  totals: {
    recordings: 10,
    failed: 1,
    kept: 22,
    found: 18,
    rejected: 9,
    repeated: 2,
    added: 5,
    timed: 8,
    onTime: 7,
  },
  tokens: 38_500,
  startedAt: '2026-10-03T15:00:00.000Z',
  completedAt: '2026-10-03T15:04:00.000Z',
  startedByName: 'Ana',
  ...fields,
});

beforeEach(() => {
  state.runs = [
    summary({ id: 'run-2', status: 'RUNNING', completedCount: 3, totals: null }),
    summary({}),
    summary({ id: 'run-0', guidanceVersion: 2, status: 'FAILED', error: 'The run was interrupted before it finished.', totals: null }),
  ];
  state.detail = {
    ...summary({}),
    houseRules: 'Scuffs are normal wear.',
    results: [
      {
        mediaId: 'media-entrance',
        inspectionId: 'insp-1',
        roomName: 'Entrance',
        propertyName: '100 Example Ln',
        inspectionType: 'MOVE_OUT',
        recordedAt: '2026-10-01T15:00:00.000Z',
        score: {
          kept: 3,
          found: 2,
          missed: [{ id: 'f-floor', title: 'Entrance floor tiles cracked' }],
          rejected: 2,
          repeated: [{ id: 'f-nail', title: 'Small nail holes in the wall', reasonCode: 'NORMAL_WEAR' }],
          added: [{ title: 'Loose door stop' }],
          timed: 2,
          onTime: 2,
        },
        error: null,
        tokens: 3500,
      },
      {
        mediaId: 'media-kitchen',
        inspectionId: 'insp-1',
        roomName: 'Kitchen',
        propertyName: '100 Example Ln',
        inspectionType: 'MOVE_OUT',
        recordedAt: '2026-10-01T15:20:00.000Z',
        score: null,
        error: 'This recording has no stored narration yet.',
        tokens: 0,
      },
    ],
  };
});

describe('test runs', () => {
  it('scores a finished run on what it found, repeated, added and placed', () => {
    render(<AiTestRuns />);
    const run = screen.getAllByRole('listitem')[1];

    expect(within(run).getByText('Draft rules (1,240 characters)')).toBeInTheDocument();
    expect(within(run).getByText('Found again').nextSibling).toHaveTextContent('18 of 22 (82%)');
    expect(within(run).getByText('False alarms repeated').nextSibling).toHaveTextContent(
      '2 of 9 (22%)',
    );
    expect(within(run).getByText('New findings').nextSibling).toHaveTextContent('5');
    expect(within(run).getByText('On the moment').nextSibling).toHaveTextContent('7 of 8 (88%)');
    expect(within(run).getByText(/1 of 10 recordings could not be analysed/)).toBeInTheDocument();
  });

  it('shows a run in progress, and why one failed', () => {
    render(<AiTestRuns />);

    expect(screen.getByText('3 of 10 recordings')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Test run progress' })).toBeInTheDocument();
    expect(screen.getByText('Saved rules, version 2')).toBeInTheDocument();
    expect(screen.getByText('The run was interrupted before it finished.')).toBeInTheDocument();
  });

  it('opens a run on each recording, with the titles behind the numbers', () => {
    render(<AiTestRuns />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Show each recording' })[1]);

    const table = screen.getByRole('table', { name: 'Each recording in the test run' });
    const entrance = within(table).getByRole('row', { name: /Entrance/ });
    expect(within(entrance).getByText('2 of 3')).toBeInTheDocument();
    expect(within(entrance).getByText('Entrance floor tiles cracked')).toBeInTheDocument();
    expect(within(entrance).getByText(/rejected as normal wear/)).toBeInTheDocument();
    expect(
      within(within(table).getByRole('row', { name: /Kitchen/ })).getByText(
        'This recording has no stored narration yet.',
      ),
    ).toBeInTheDocument();
  });

  it('says how to start one when there are none', () => {
    state.runs = [];
    render(<AiTestRuns />);

    expect(screen.getByText(/No test runs yet/)).toBeInTheDocument();
  });
});
