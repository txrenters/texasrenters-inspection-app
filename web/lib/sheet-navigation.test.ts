import { describe, expect, it } from 'vitest';

import { cellAfter, cellGrid, parseCopied, pasteTargets } from './sheet-navigation';

/** Moving about a sheet from the keyboard (2026-11-18): a table's body laid out as Excel lays out a sheet. */

function table(html: string) {
  const element = document.createElement('table');
  element.innerHTML = `<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>${html}</tbody>`;
  document.body.append(element);
  return element;
}
const at = (element: HTMLTableElement, text: string) => Array.from(element.querySelectorAll('td')).find((cell) => cell.textContent === text)!;

describe('a sheet laid out as a grid', () => {
  const sheet = () => table('<tr><td>a1</td><td>b1</td><td>c1</td></tr><tr><td>Total</td><td colspan="2">total</td></tr><tr><td>a3</td><td>b3</td><td>c3</td></tr>');

  it('moves a cell at a time, past every column a cell spans, and stays at the edges', () => {
    const element = sheet();
    const grid = cellGrid(element);
    expect(cellAfter(grid, at(element, 'b1'), 'down').textContent).toBe('total');
    expect(cellAfter(grid, at(element, 'total'), 'down').textContent).toBe('b3');
    expect(cellAfter(grid, at(element, 'Total'), 'right').textContent).toBe('total');
    expect(cellAfter(grid, at(element, 'total'), 'right').textContent).toBe('total');
    expect(cellAfter(grid, at(element, 'a1'), 'up').textContent).toBe('a1');
    expect(cellAfter(grid, at(element, 'b3'), 'rowStart').textContent).toBe('a3');
    expect(cellAfter(grid, at(element, 'a1'), 'last').textContent).toBe('c3');
    expect(cellAfter(grid, at(element, 'c3'), 'first').textContent).toBe('a1');
  });

  it('skips a row the search hides', () => {
    const element = sheet();
    element.tBodies[0]!.rows[1]!.setAttribute('data-find-hide', '');
    expect(cellAfter(cellGrid(element), at(element, 'b1'), 'down').textContent).toBe('b3');
  });
});

describe('what was copied', () => {
  it("reads Excel's block: tabs between cells, a line a row, a line break in quotes", () => {
    expect(parseCopied('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCopied('"Gate code\nchanged"\t"say ""hi"""')).toEqual([['Gate code\nchanged', 'say "hi"']]);
    expect(parseCopied('20373')).toEqual([['20373']]);
  });

  it('goes in from the selected cell, across and down, as far as the sheet reaches', () => {
    const element = table('<tr><td>a1</td><td>b1</td><td>c1</td></tr><tr><td>a2</td><td>b2</td><td>c2</td></tr>');
    const targets = pasteTargets(at(element, 'b1'), [
      ['x', 'y', 'z'],
      ['p', 'q'],
      ['beyond'],
    ]);
    expect(targets.map(({ cell, text }) => `${cell.textContent}=${text}`)).toEqual(['b1=x', 'c1=y', 'b2=p', 'c2=q']);
  });
});
