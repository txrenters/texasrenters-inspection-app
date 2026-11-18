import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TableBody, TableHeader, TableRow } from '@/components/ui/table';

import { GridCell, Sheet, SheetHead, TotalCell } from './grid';
import { SheetFindBar, SheetKeysProvider } from './sheet-keys';

/**
 * The sheets worked from the keyboard, as Excel is (2026-11-18, the office:
 * "keyboard shortcuts also on the console spreadsheet and a searchable
 * cell/data", "add a help too to access the shortcuts"). Everything invented.
 */

vi.mock('@/lib/actual-vs-budget-live', () => ({
  useActualVsBudgetLive: () => ({ connected: false, others: [], cellOwners: new Map(), focusCell: () => undefined }),
  editorColour: () => '#000',
  initials: () => 'XX',
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const saved = vi.fn();
const START = { 'a:job': '20373', 'a:note': 'Gate code', 'b:job': '20374', 'b:note': '' } as Record<string, string>;

function Harness() {
  const area = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState(START);
  const commit = (name: string) => async (typed: string) => {
    saved(name, typed);
    setValues((current) => ({ ...current, [name]: typed }));
    return true;
  };
  const row = (id: string, address: string) => (
    <TableRow>
      <GridCell label={`${id} address`} readOnly text={address} />
      <GridCell cell={`${id}:job`} label={`${id} job`} onCommit={commit(`${id}:job`)} text={values[`${id}:job`]!} />
      <GridCell cell={`${id}:note`} label={`${id} note`} onCommit={commit(`${id}:note`)} text={values[`${id}:note`]!} />
    </TableRow>
  );
  return (
    <SheetKeysProvider area={area}>
      <SheetFindBar />
      <div ref={area}>
        <Sheet>
          <TableHeader>
            <TableRow>
              <SheetHead>Address</SheetHead>
              <SheetHead>Job#</SheetHead>
              <SheetHead>Notes</SheetHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {row('a', '24 Florence St - Zone 4')}
            {row('b', '7 Maple Grove Dr - Zone 2')}
            <TableRow>
              <TotalCell>Total</TotalCell>
              <TotalCell span={2}>2 visits</TotalCell>
            </TableRow>
          </TableBody>
        </Sheet>
      </div>
    </SheetKeysProvider>
  );
}

const cell = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const press = (key: string, options: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.activeElement!, { key, ...options });

beforeEach(() => saved.mockReset());

describe('the keyboard on a sheet', () => {
  it('moves the selection with the arrows, Enter and Tab -- a Total too -- without editing anything', () => {
    render(<Harness />);
    act(() => cell('a job').focus());
    press('ArrowDown');
    expect(document.activeElement).toBe(cell('b job'));
    press('Tab');
    expect(document.activeElement).toBe(cell('b note'));
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('2 visits');
    press('Home');
    expect(document.activeElement?.textContent).toBe('Total');
    press('Enter', { shiftKey: true });
    expect(document.activeElement).toBe(cell('b address'));
    press('Home', { ctrlKey: true });
    expect(document.activeElement).toBe(cell('a address'));
    expect(saved).not.toHaveBeenCalled();
  });

  it('types over a selected cell, as Excel does, saves it on Enter and goes down; Escape puts it back', async () => {
    render(<Harness />);
    act(() => cell('a job').focus());
    expect(cell('a job')).toHaveAttribute('readonly');
    press('2');
    expect(cell('a job')).not.toHaveAttribute('readonly');
    fireEvent.change(cell('a job'), { target: { value: '21008' } });
    await act(async () => void press('Enter'));
    expect(saved).toHaveBeenCalledWith('a:job', '21008');
    expect(document.activeElement).toBe(cell('b job'));

    press('9');
    press('Escape');
    expect(cell('b job').value).toBe('20374');
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('edits in place on F2, where the arrows move the caret, not the selection', () => {
    render(<Harness />);
    act(() => cell('a note').focus());
    press('F2');
    expect(cell('a note').value).toBe('Gate code');
    press('ArrowLeft');
    expect(document.activeElement).toBe(cell('a note'));
  });

  it('clears the selected cell alone on Delete, never a worked-out one', async () => {
    render(<Harness />);
    act(() => cell('a note').focus());
    await act(async () => void press('Delete'));
    expect(saved).toEqual(expect.anything());
    expect(saved.mock.calls).toEqual([['a:note', '']]);
    act(() => cell('a address').focus());
    await act(async () => void press('Delete'));
    expect(saved).toHaveBeenCalledTimes(1);
    expect(cell('a address').value).toBe('24 Florence St - Zone 4');
  });

  it('takes a save back on Ctrl+Z, and puts it again on Ctrl+Y -- each a save of its own', async () => {
    render(<Harness />);
    act(() => cell('a job').focus());
    press('2');
    fireEvent.change(cell('a job'), { target: { value: '21008' } });
    await act(async () => void press('Enter'));
    await act(async () => void press('z', { ctrlKey: true }));
    expect(saved).toHaveBeenLastCalledWith('a:job', '20373');
    expect(cell('a job').value).toBe('20373');
    await act(async () => void press('y', { ctrlKey: true }));
    expect(saved).toHaveBeenLastCalledWith('a:job', '21008');
  });

  it('pastes a block copied from Excel across and down from the selected cell, leaving out a worked-out one, and takes it back at once', async () => {
    render(<Harness />);
    act(() => cell('a address').focus());
    await act(async () => void fireEvent.paste(cell('a address'), { clipboardData: { getData: () => 'x\t21100\tFirst\ny\t21101\tSecond' } }));
    expect(saved.mock.calls).toEqual([
      ['a:job', '21100'],
      ['a:note', 'First'],
      ['b:job', '21101'],
      ['b:note', 'Second'],
    ]);
    expect(cell('a address').value).toBe('24 Florence St - Zone 4');
    saved.mockReset();
    await act(async () => void press('z', { ctrlKey: true }));
    expect(saved.mock.calls).toEqual([
      ['a:job', '20373'],
      ['a:note', 'Gate code'],
      ['b:job', '20374'],
      ['b:note', ''],
    ]);
  });

  it('copies what a selected cell shows', () => {
    render(<Harness />);
    act(() => cell('a job').focus());
    const setData = vi.fn();
    fireEvent.copy(cell('a job'), { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', '20373');
  });
});

describe('finding in a sheet', () => {
  it('marks every cell holding what is looked for, steps through them, and can show only their rows', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    const box = screen.getByLabelText('Find in this sheet');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: '2037' } });
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(cell('a job').closest('td')).toHaveAttribute('data-find', 'current');
    expect(cell('b job').closest('td')).toHaveAttribute('data-find', 'match');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(cell('b job').closest('td')).toHaveAttribute('data-find', 'current');

    fireEvent.change(box, { target: { value: 'florence' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only matching rows' }));
    expect(cell('a address').closest('tr')).not.toHaveAttribute('data-find-hide');
    expect(cell('b address').closest('tr')).toHaveAttribute('data-find-hide');
    // Escape goes back to the sheet, on the match.
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(cell('a address'));
  });

  it('says so when nothing matches', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Find in this sheet'), { target: { value: 'no such thing' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});

describe('the shortcuts', () => {
  it('are listed on ? or the Shortcuts button -- but ? typed into a cell being edited stays a ?', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Shortcuts/ }));
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Undo / redo a save')).toBeInTheDocument();
    expect(within(dialog).getByText('Find in this sheet')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => cell('a note').focus());
    press('?');
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    act(() => cell('a note').focus());
    press('F2');
    press('?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
