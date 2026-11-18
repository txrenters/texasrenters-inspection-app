/**
 * Moving about a sheet from the keyboard, as in Excel (2026-11-18, the office:
 * "keyboard shortcuts also on the console spreadsheet"). A sheet is an HTML
 * table; its body's cells are laid out in a grid -- a cell spanning columns
 * takes each of them -- and a move goes to the next cell in that direction,
 * skipping a row the search hides. The cell's text box takes the focus where
 * it has one; a Total's cell is focused itself.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';
export type Move = Direction | 'rowStart' | 'rowEnd' | 'first' | 'last' | 'pageUp' | 'pageDown';

/** Rows a page up or down moves. */
const PAGE = 10;

/** The body's cells as Excel would lay them out: one row each, a cell spanning columns in each of them. */
export function cellGrid(table: HTMLTableElement): HTMLTableCellElement[][] {
  const rows: HTMLTableCellElement[][] = [];
  for (const body of Array.from(table.tBodies))
    for (const row of Array.from(body.rows)) {
      if (row.hasAttribute('data-find-hide')) continue;
      const cells: HTMLTableCellElement[] = [];
      for (const cell of Array.from(row.cells)) for (let span = 0; span < Math.max(1, cell.colSpan); span++) cells.push(cell);
      if (cells.length) rows.push(cells);
    }
  return rows;
}

/** Where a cell is in its sheet's grid: its row, and the first column it takes. */
export function placeOf(grid: HTMLTableCellElement[][], cell: HTMLTableCellElement) {
  for (let row = 0; row < grid.length; row++) {
    const column = grid[row]!.indexOf(cell);
    if (column >= 0) return { row, column };
  }
  return null;
}

/** The cell a move from `cell` lands on; the same cell when there is nowhere to go. */
export function cellAfter(grid: HTMLTableCellElement[][], cell: HTMLTableCellElement, move: Move): HTMLTableCellElement {
  const place = placeOf(grid, cell);
  if (!place) return cell;
  const at = (row: number, column: number) => {
    const line = grid[Math.max(0, Math.min(grid.length - 1, row))]!;
    return line[Math.max(0, Math.min(line.length - 1, column))]!;
  };
  switch (move) {
    case 'up':
      return at(place.row - 1, place.column);
    case 'down':
      return at(place.row + 1, place.column);
    case 'pageUp':
      return at(place.row - PAGE, place.column);
    case 'pageDown':
      return at(place.row + PAGE, place.column);
    case 'left':
      return at(place.row, place.column - 1);
    case 'right': {
      // Past every column this cell spans.
      const line = grid[place.row]!;
      let column = place.column;
      while (column < line.length - 1 && line[column] === cell) column += 1;
      return line[column]!;
    }
    case 'rowStart':
      return at(place.row, 0);
    case 'rowEnd':
      return at(place.row, Number.MAX_SAFE_INTEGER);
    case 'first':
      return at(0, 0);
    case 'last':
      return at(grid.length - 1, Number.MAX_SAFE_INTEGER);
  }
}

/** What takes the focus in a cell: its text box, or the cell itself. */
export function focusTarget(cell: HTMLTableCellElement): HTMLElement {
  const box = cell.querySelector<HTMLElement>('textarea');
  if (box) return box;
  if (cell.tabIndex < 0 && !cell.hasAttribute('tabindex')) cell.tabIndex = -1;
  return cell;
}

/** Select the cell a move from `from` lands on, scrolled into view. Returns it, or null when `from` is not in a sheet. */
export function moveFrom(from: HTMLElement, move: Move): HTMLElement | null {
  const cell = from.closest('td');
  const table = cell?.closest('table');
  if (!cell || !table) return null;
  const next = focusTarget(cellAfter(cellGrid(table), cell, move));
  next.focus();
  next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return next;
}

/** A cell's text, as it shows: its text box's, or the cell's own. */
export function cellTextOf(cell: HTMLTableCellElement): string {
  const box = cell.querySelector('textarea');
  return box ? box.value : (cell.textContent ?? '');
}

/**
 * What was copied, as rows of cells: Excel copies a block as tab-separated
 * lines, a cell holding a line break in quotes.
 */
export function parseCopied(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (quoted) {
      if (character === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === '\t') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** The cells a block pasted at `from` goes into: as far as the sheet reaches, one cell per value. */
export function pasteTargets(from: HTMLTableCellElement, block: string[][]): { cell: HTMLTableCellElement; text: string }[] {
  const table = from.closest('table');
  if (!table) return [];
  const grid = cellGrid(table);
  const place = placeOf(grid, from);
  if (!place) return [];
  const targets: { cell: HTMLTableCellElement; text: string }[] = [];
  block.forEach((values, rowOffset) => {
    const line = grid[place.row + rowOffset];
    if (!line) return;
    let column = place.column;
    for (const text of values) {
      const cell = line[column];
      if (!cell) break;
      targets.push({ cell, text });
      // The next value goes in the next cell along, past every column this one spans.
      while (column < line.length && line[column] === cell) column += 1;
    }
  });
  return targets;
}
