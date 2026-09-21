import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DataTable, type Column } from './data-table';

type Row = { id: string; day: string };

const ROWS: Row[] = [
  { id: 'a', day: 'Dec 31, 2026' },
  { id: 'b', day: 'Dec 24, 2026' },
];

const COLUMNS: Array<Column<Row>> = [
  { key: 'property', header: 'Property', primary: true, cell: (row) => row.id },
  { key: 'scheduled', header: 'Scheduled', sortable: true, cell: (row) => row.day },
];

const table = (props: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) => (
  <DataTable columns={COLUMNS} rowKey={(row) => row.id} rows={ROWS} {...props} />
);

/**
 * Turning the list around (the office, 2026-09-21: "can we add a function also
 * in this column that if I click the sort will rotate from that to newest?").
 *
 * The order belongs to the API — these are twenty rows of 1,533 — so the table
 * reports the click and renders what it is given. It never reorders `rows`,
 * which would sort the page and call it the list.
 */
describe('a sortable column header', () => {
  it('reports the column that was clicked, and leaves the rows alone', () => {
    const onChange = vi.fn();

    render(table({ sort: { by: 'scheduled', direction: 'desc', onChange } }));
    fireEvent.click(screen.getByRole('button', { name: /scheduled/i }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith('scheduled');
    const cells = screen.getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['a', 'Dec 31, 2026', 'b', 'Dec 24, 2026']);
  });

  /** What a screen reader is told. The arrow is decoration and says nothing. */
  it('announces the direction on the cell, not on the arrow', () => {
    const { rerender } = render(
      table({ sort: { by: 'scheduled', direction: 'desc', onChange: vi.fn() } }),
    );

    expect(screen.getByRole('columnheader', { name: /scheduled/i })).toHaveAttribute(
      'aria-sort',
      'descending',
    );

    rerender(table({ sort: { by: 'scheduled', direction: 'asc', onChange: vi.fn() } }));

    expect(screen.getByRole('columnheader', { name: /scheduled/i })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('says so when the list is ordered by some other column', () => {
    render(table({ sort: { by: 'property', direction: 'asc', onChange: vi.fn() } }));

    expect(screen.getByRole('columnheader', { name: /scheduled/i })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  /**
   * Every other table in the console passes no `sort`. A header that offers a
   * click nothing listens for is worse than a plain label.
   */
  it('is a plain label in a table that does not sort', () => {
    render(table());

    expect(screen.queryByRole('button', { name: /scheduled/i })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /scheduled/i })).not.toHaveAttribute(
      'aria-sort',
    );
  });

  it('turns around and back again, one click at a time', () => {
    function Harness() {
      const [asc, setAsc] = useState(false);
      return (
        <>
          {table({
            sort: { by: 'scheduled', direction: asc ? 'asc' : 'desc', onChange: () => setAsc(!asc) },
          })}
        </>
      );
    }
    render(<Harness />);
    const header = () => screen.getByRole('columnheader', { name: /scheduled/i });

    expect(header()).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: /scheduled/i }));
    expect(header()).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /scheduled/i }));
    expect(header()).toHaveAttribute('aria-sort', 'descending');
  });
});
