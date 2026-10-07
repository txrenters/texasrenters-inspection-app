import type { AreaChecklistEntry } from '@texasrenters/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AreaConditionChecklist } from './AreaConditionChecklist';

/**
 * "Fill from narration" (2026-10-07): the rows nobody ticked, read from what
 * the inspector said. The reviewer has to be able to tell those rows from the
 * ones a person ticked, and the controls belong on a room checklist only.
 */

const state = vi.hoisted(() => ({
  fillRoom: vi.fn(),
  fillEvery: vi.fn(),
  roomData: undefined as { asked: number; filled: number } | undefined,
}));

vi.mock('@/lib/queries', () => ({
  useRecordChecklistItem: () => ({ isPending: false, variables: undefined, error: null, mutate: () => {} }),
  useFillAreaFromNarration: () => ({
    isPending: false,
    error: null,
    data: state.roomData,
    mutate: state.fillRoom,
  }),
  useFillInspectionFromNarration: () => ({
    isPending: false,
    error: null,
    data: undefined,
    mutate: state.fillEvery,
  }),
}));

function row(overrides: Partial<AreaChecklistEntry> = {}): AreaChecklistEntry {
  return {
    itemId: 'doors',
    label: 'Doors and locks',
    isClean: null,
    isUndamaged: null,
    isWorking: null,
    comment: null,
    recordedAt: null,
    videoTimestampSeconds: null,
    section: null,
    responseType: 'STATUS',
    unit: null,
    numericValue: null,
    textValue: null,
    source: null,
    ...overrides,
  } as AreaChecklistEntry;
}

function renderChecklist(checklist: AreaChecklistEntry[], canReview = true) {
  return render(
    <AreaConditionChecklist areaId="area-1" canReview={canReview} checklist={checklist} inspectionId="inspection-1" />,
  );
}

describe('filling the checklist from the narration', () => {
  beforeEach(() => {
    state.fillRoom.mockReset();
    state.fillEvery.mockReset();
    state.roomData = undefined;
  });

  it('marks a row the AI filled, and only that row', () => {
    renderChecklist([
      row({ itemId: 'doors', isUndamaged: false, recordedAt: '2026-10-07T12:00:00Z', source: 'AI' }),
      row({ itemId: 'walls', label: 'Walls and ceilings', isClean: true, recordedAt: '2026-10-05T22:04:00Z', source: 'PERSON' }),
    ]);

    expect(screen.getAllByText('Filled by AI from the narration')).toHaveLength(1);
  });

  it('fills this room, or every room, on the reviewer’s click', () => {
    renderChecklist([row()]);

    fireEvent.click(screen.getByRole('button', { name: /Fill this room from the narration/ }));
    fireEvent.click(screen.getByRole('button', { name: /Fill every room/ }));

    expect(state.fillRoom).toHaveBeenCalledTimes(1);
    expect(state.fillEvery).toHaveBeenCalledTimes(1);
  });

  it('says what the room’s run filled', () => {
    state.roomData = { asked: 8, filled: 6 };
    renderChecklist([row()]);

    expect(screen.getByText('Filled 6 of 8 unticked rows from the narration.')).toBeInTheDocument();
  });

  it('is not offered to someone who cannot change the inspection, or on an HVAC form', () => {
    const { unmount } = renderChecklist([row()], false);
    expect(screen.queryByRole('button', { name: /Fill this room/ })).not.toBeInTheDocument();
    unmount();

    renderChecklist([row({ section: 'Attic' })]);
    expect(screen.queryByRole('button', { name: /Fill this room/ })).not.toBeInTheDocument();
  });
});
