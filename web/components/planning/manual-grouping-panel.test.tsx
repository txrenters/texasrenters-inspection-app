import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

const panel = (onCreate = vi.fn(), editingBy?: ReadonlyMap<string, readonly string[]>) =>
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
