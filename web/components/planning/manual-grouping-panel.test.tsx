import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { calmGroupColorOf, type GroupFileRow } from './group-file';
import type { ManualState } from './manual-grouping';
import { ManualGroupingPanel } from './manual-grouping-panel';

/**
 * The New group dialog's name (the office, 2026-10-01): "if for example the
 * Group 4 name/label is already in use then it should also intelligently
 * suggest the group name".
 */

const state: ManualState = {
  groups: [
    { id: 'g1', name: 'Group 1', color: '#f3c300', target: 9, stops: [] },
    { id: 'g2', name: 'Group 2', color: '#875692', target: 9, stops: [] },
    { id: 'g4', name: 'Group 4', color: '#f38400', target: 9, stops: [] },
  ],
};

const panel = (
  onCreate = vi.fn(),
  editingBy?: ReadonlyMap<string, readonly string[]>,
  overrides: Partial<ComponentProps<typeof ManualGroupingPanel>> = {},
) =>
  render(
    <ManualGroupingPanel
      activeId={null}
      autoOrder={false}
      byRow={new Map()}
      canRedo={false}
      canUndo={false}
      dimOthers={false}
      minutesPerProperty={30}
      onAutoOrder={vi.fn()}
      onCreate={onCreate}
      onDelete={vi.fn()}
      onDimOthers={vi.fn()}
      onExport={vi.fn()}
      onMinutesPerProperty={vi.fn()}
      onOptimize={vi.fn()}
      onRaiseTarget={vi.fn()}
      onRedo={vi.fn()}
      onRemoveStop={vi.fn()}
      onReorder={vi.fn()}
      onSelect={vi.fn()}
      onUndo={vi.fn()}
      onUpdate={vi.fn()}
      ordering={new Set()}
      routeViews={new Map()}
      state={state}
      total={10}
      {...(editingBy ? { editingBy } : {})}
      {...overrides}
    />,
  );

describe('naming a new group', () => {
  it('offers the next name in the groups’ own pattern', () => {
    panel();

    fireEvent.click(screen.getByRole('button', { name: /New group/ }));

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Group 5');
  });

  it('says when a name is taken, and offers a free one in a click', () => {
    const onCreate = vi.fn();
    panel(onCreate);
    fireEvent.click(screen.getByRole('button', { name: /New group/ }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'group 4' } });

    expect(screen.getByText(/Another group is called group 4/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Use group 5' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('group 5');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ name: 'group 5' });
  });
});

describe('a live template', () => {
  it('says who else is building a group', () => {
    panel(vi.fn(), new Map([['g2', ['Maria']]]));

    expect(screen.getByText('Maria is building it')).toBeTruthy();
  });
});

/** T35 (console-development): a white numeral with a shadow was unreadable on the pale group colours. */
describe('the group numbers', () => {
  const discOf = (name: string) =>
    screen.getByText(name).closest('button')!.querySelector<HTMLElement>('span[aria-hidden]')!;
  /** A colour as the browser writes it back, so a hex and an rgb() compare. */
  const asStyled = (color: string) => {
    const probe = document.createElement('span');
    probe.style.color = color;
    return probe.style.color;
  };

  it('writes each in whichever of white or near-black reads on its painted colour', () => {
    panel();

    const yellow = calmGroupColorOf('#f3c300')!;
    const purple = calmGroupColorOf('#875692')!;
    expect(discOf('Group 1').style.backgroundColor).toBe(asStyled(yellow.fill));
    expect(discOf('Group 1').style.color).toBe(asStyled(yellow.ink));
    expect(discOf('Group 2').style.color).toBe(asStyled(purple.ink));
    // A pale yellow takes the dark numeral; no shadow propping up a white one.
    expect(yellow.ink).not.toBe('#ffffff');
    expect(discOf('Group 1').style.textShadow).toBe('');
  });
});

describe('the stops of the group being built', () => {
  const row = (rowNumber: number, address: string, unit: string | null) =>
    ({ rowNumber, address, unit, city: 'Katy', latitude: 29.7 + rowNumber / 100, longitude: -95.7 }) as unknown as GroupFileRow;

  it('names the stop each move and removal is for', () => {
    const onReorder = vi.fn();
    const onRemoveStop = vi.fn();
    panel(vi.fn(), undefined, {
      activeId: 'g1',
      byRow: new Map([
        [1, row(1, '1 Any St', null)],
        [2, row(2, '2 Any St', 'B')],
      ]),
      onRemoveStop,
      onReorder,
      state: { groups: [{ ...state.groups[0]!, stops: [1, 2] }, ...state.groups.slice(1)] },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Move 2 Any St, B earlier' }));
    expect(onReorder).toHaveBeenCalledWith('g1', 1, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Move 1 Any St later' }));
    expect(onReorder).toHaveBeenCalledWith('g1', 0, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Take 1 Any St out of the group' }));
    expect(onRemoveStop).toHaveBeenCalledWith(1);
  });
});
