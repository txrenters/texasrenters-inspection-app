import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './ui/alert-dialog';

import { DataTable, FilterToolbar, LoadingState, RowAction, RowActions, TableLoadingState } from './shared';

describe('LoadingState', () => {
  it('announces the current loading task and exposes a busy container', () => {
    const { container } = render(<LoadingState label="Loading operational metrics…" />);

    expect(
      screen.getByRole('status', { name: 'Loading operational metrics…' }),
    ).toBeInTheDocument();
    expect(screen.getByText('TEXASRENTERS')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});

describe('TableLoadingState', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the branded loader first and transitions to a table-shaped skeleton', () => {
    vi.useFakeTimers();
    render(
      <TableLoadingState headers={['Property', 'Status']} rows={3} label="Loading properties" />,
    );

    expect(screen.getByRole('status', { name: 'Loading properties' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(350));

    expect(screen.getByRole('table', { name: 'Loading properties' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});

describe('DataTable actions column', () => {
  it('names the unlabelled trailing column for assistive technology', () => {
    render(
      <DataTable headers={['Property', '']} label="Properties">
        <tr>
          <td>A property</td>
          <td>
            <RowActions>
              <RowAction href="/properties/1" icon={<svg />} label="Open" />
            </RowActions>
          </td>
        </tr>
      </DataTable>,
    );

    // Without this the actions cells are announced against a blank header.
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });

  it('keeps the skeleton column count matching the real table', () => {
    vi.useFakeTimers();
    render(<TableLoadingState headers={['Property', '']} rows={1} label="Loading properties" />);
    act(() => vi.advanceTimersByTime(350));

    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('RowAction', () => {
  it('renders a named link when given a destination', () => {
    render(<RowAction href="/inspections/42" icon={<svg />} label="Inspection" />);

    // The label carries the accessible name: the icon is decorative, so an
    // icon-only control without it announces as nothing at all.
    expect(screen.getByRole('link', { name: 'Inspection' })).toHaveAttribute(
      'href',
      '/inspections/42',
    );
  });

  it('renders a button that calls its handler when given no destination', () => {
    const onClick = vi.fn();
    render(<RowAction icon={<svg />} label="Retry" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Retry' });
    expect(button).toHaveAttribute('type', 'button');
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('passes disabled through so a pending mutation cannot be fired twice', () => {
    render(<RowAction disabled icon={<svg />} label="Delete" variant="danger" />);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  // The roles table hangs its delete confirmation off a RowAction. Radix clones
  // the trigger onto this component, so the props and ref have to reach the
  // underlying button — if they stop doing so the dialog silently never opens
  // and the only symptom is a delete button that does nothing.
  it('works as an asChild trigger for a Radix dialog', async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <RowAction icon={<svg />} label="Delete" variant="danger" />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this role?</AlertDialogTitle>
          <AlertDialogDescription>It cannot be undone.</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('alertdialog', { name: 'Delete this role?' })).toBeInTheDocument(),
    );
  });
});

describe('FilterToolbar', () => {
  it('announces the result count and exposes a clear action only when supplied', () => {
    const clear = vi.fn();
    render(
      <FilterToolbar resultLabel="24 inspections" onClear={clear}>
        <input aria-label="Search" />
      </FilterToolbar>,
    );

    expect(screen.getByText('24 inspections')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Clear filters' }).click();
    expect(clear).toHaveBeenCalledOnce();
  });
});
