import type { AiAnalysisPreview, AiGuidanceHistory } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiHouseRules } from './ai-house-rules';

/**
 * The office's house rules for the AI, written in Settings, kept in versions,
 * and tried on a recording the office already decided before they are saved.
 */

const state = vi.hoisted(() => ({
  history: null as AiGuidanceHistory | null,
  save: vi.fn(),
  preview: vi.fn(),
  previewData: undefined as AiAnalysisPreview | undefined,
  testRun: vi.fn(),
}));

vi.mock('@/lib/queries', () => ({
  useAiGuidance: () => ({
    data: state.history,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAiGuidanceSamples: () => ({
    data: [
      {
        mediaId: 'media-entrance',
        inspectionId: 'insp-1',
        roomName: 'Entrance',
        propertyName: '100 Example Ln',
        inspectionType: 'MOVE_OUT',
        recordedAt: '2026-10-01T15:00:00.000Z',
        findings: 3,
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAiGuidanceMutations: () => ({
    save: { mutate: state.save, isPending: false, isError: false, error: null },
    preview: {
      mutate: state.preview,
      isPending: false,
      error: null,
      data: state.previewData,
      variables: undefined,
    },
    startTestRun: {
      mutate: state.testRun,
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
      data: undefined,
    },
  }),
}));

const HISTORY: AiGuidanceHistory = {
  current: { version: 2, text: 'Nail holes are normal wear.' },
  versions: [
    { version: 2, createdAt: '2026-10-03T14:00:00.000Z', createdByName: 'Ana', length: 27 },
    { version: 1, createdAt: '2026-10-02T14:00:00.000Z', createdByName: 'Ana', length: 12 },
  ],
};

beforeEach(() => {
  state.history = HISTORY;
  state.previewData = undefined;
  state.save.mockReset();
  state.preview.mockReset();
  state.testRun.mockReset();
});


/**
 * The two ways to test the rules sit under one "Test…" menu
 * (console-development), so a test opens it and picks one.
 */
function chooseTest(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Test…' }), {
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  });
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

describe('the house rules card', () => {
  it('starts from the rules in use and saves a change as the next version', () => {
    render(<AiHouseRules canConfigure />);

    const rules = screen.getByRole('textbox', { name: 'House rules' });
    expect(rules).toHaveValue('Nail holes are normal wear.');
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save as version 3' });
    expect(save).toBeDisabled();

    fireEvent.change(rules, {
      target: { value: 'Nail holes are normal wear.\nDirt is a cleaning item.' },
    });
    fireEvent.click(save);

    expect(state.save).toHaveBeenCalledWith('Nail holes are normal wear.\nDirt is a cleaning item.');
  });

  it('offers the example when there are no rules yet', () => {
    state.history = { current: { version: 0, text: '' }, versions: [] };
    render(<AiHouseRules canConfigure />);

    expect(screen.getByText('No rules yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start from the example' }));

    expect(
      (screen.getByRole('textbox', { name: 'House rules' }) as HTMLTextAreaElement).value,
    ).toContain('Normal wear and tear');
  });

  it('follows a colleague’s new version, but never over a draft being written', () => {
    const { rerender } = render(<AiHouseRules canConfigure />);
    const rules = () => screen.getByRole('textbox', { name: 'House rules' });

    state.history = { ...HISTORY, current: { version: 3, text: 'A colleague’s rules.' } };
    rerender(<AiHouseRules canConfigure />);
    expect(rules()).toHaveValue('A colleague’s rules.');

    fireEvent.change(rules(), { target: { value: 'My draft.' } });
    state.history = { ...HISTORY, current: { version: 4, text: 'Another colleague’s rules.' } };
    rerender(<AiHouseRules canConfigure />);
    expect(rules()).toHaveValue('My draft.');
  });

  it('is read-only to someone who does not configure the AI', () => {
    render(<AiHouseRules canConfigure={false} />);

    expect(screen.getByRole('textbox', { name: 'House rules' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save as version/ })).not.toBeInTheDocument();
    // Neither test action is offered: the "Test…" menu that holds them is gone.
    expect(screen.queryByRole('button', { name: 'Test…' })).not.toBeInTheDocument();
  });
});

describe('testing the rules on the recent recordings', () => {
  it('runs the rules as typed, unsaved, on every recent decided recording', () => {
    render(<AiHouseRules canConfigure />);
    fireEvent.change(screen.getByRole('textbox', { name: 'House rules' }), {
      target: { value: 'Scuffs are normal wear.' },
    });

    chooseTest('Test on recent recordings');

    expect(state.testRun).toHaveBeenCalledWith('Scuffs are normal wear.');
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe('trying the rules on a recording', () => {
  it('runs the rules as typed, unsaved, on the recording chosen', () => {
    render(<AiHouseRules canConfigure />);
    fireEvent.change(screen.getByRole('textbox', { name: 'House rules' }), {
      target: { value: 'Scuffs are normal wear.' },
    });

    chooseTest('Try on a recording');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Try the rules on Entrance · 100 Example Ln · Move out',
      }),
    );

    expect(state.preview).toHaveBeenCalledWith({
      mediaId: 'media-entrance',
      houseRules: 'Scuffs are normal wear.',
    });
    expect(state.save).not.toHaveBeenCalled();
  });

  it('sets what the draft finds beside what the office decided', () => {
    state.previewData = {
      mediaId: 'media-entrance',
      inspectionId: 'insp-1',
      roomName: 'Entrance',
      modelId: 'gpt-5.6-sol',
      tokens: 4200,
      summary: 'Fair condition.',
      draft: [
        {
          title: 'Holes in the entrance door',
          description: '',
          severity: 'MEDIUM',
          findingType: 'POSSIBLE_NEW_DAMAGE',
          category: 'Doors',
          comparisonResult: 'POSSIBLE_NEW_DAMAGE',
          possibleResponsibility: 'UNDETERMINED',
          confidence: 0.8,
          videoTimestampStart: 18,
          videoTimestampEnd: 24,
        },
      ],
      current: [
        {
          id: 'f-door',
          title: 'Entrance door has holes',
          description: '',
          severity: 'MEDIUM',
          findingType: 'POSSIBLE_NEW_DAMAGE',
          category: 'Doors',
          source: 'NARRATION',
          reviewStatus: 'APPROVED',
          videoTimestampStart: 18,
          videoTimestampEnd: 24,
          lastReview: { status: 'APPROVED', reason: null, reasonCode: null },
        },
        {
          id: 'f-scuff',
          title: 'Scuffed wall',
          description: '',
          severity: 'LOW',
          findingType: 'POSSIBLE_NEW_DAMAGE',
          category: 'Walls',
          source: 'NARRATION',
          reviewStatus: 'REJECTED',
          videoTimestampStart: 30,
          videoTimestampEnd: 32,
          lastReview: { status: 'REJECTED', reason: null, reasonCode: 'NORMAL_WEAR' },
        },
      ],
    };
    render(<AiHouseRules canConfigure />);
    chooseTest('Try on a recording');

    const result = screen.getByRole('region', { name: 'Trial result' });
    expect(
      within(result).getByText(
        'Entrance: Of the 1 the office rejected, the draft drops 1. Of the 1 it approved, the draft still finds 1.',
      ),
    ).toBeInTheDocument();
    expect(within(result).getByText('Rejected · Normal wear · Low')).toBeInTheDocument();
    expect(within(result).getByText('Gone in the draft')).toBeInTheDocument();
    expect(within(result).getByText('Holes in the entrance door')).toBeInTheDocument();
  });
});
