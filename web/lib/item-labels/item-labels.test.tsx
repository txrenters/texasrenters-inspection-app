/**
 * @vitest-environment node
 *
 * Rendered as the purchase order PDF is tested, on @react-pdf's Node build.
 * A label has no images: its bars are shapes.
 */
import { renderToBuffer } from '@react-pdf/renderer';
import { describe, expect, it } from 'vitest';

import { labelsFileName } from './download-labels';
import { qrModules, qrPath, stripeModules, stripeRuns } from './label-codes';
import { ItemLabelsDocument, labelName } from './label-document';
import { MOST_LABELS, labelPages, labelsOf, labelsProblem, labelsSummary, readCopies, type LabelPick } from './label-sheets';

/** Item labels (2026-11-19). Every code and description invented. */

const PICKS: LabelPick[] = [
  { code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'pcs', copies: 6 },
  { code: 'BAT-9V', name: 'Battery, 9 V', unit: 'pcs', copies: 2 },
];

describe('the stripes', () => {
  it('are Code 128: a start, a symbol a character, a check and a stop', () => {
    const modules = stripeModules('FLT-16251');
    // Start B is 11010010000, and every Code 128 ends 1100011101011.
    expect(modules.slice(0, 11).map(Number).join('')).toBe('11010010000');
    expect(modules.slice(-13).map(Number).join('')).toBe('1100011101011');
    // Eleven modules a symbol, thirteen for the stop.
    expect((modules.length - 13) % 11).toBe(0);
  });

  it('differ for different codes, and are the same each time for one', () => {
    expect(stripeModules('FLT-16251')).toEqual(stripeModules('FLT-16251'));
    expect(stripeModules('FLT-16251')).not.toEqual(stripeModules('FLT-16252'));
  });

  it('are drawn as runs that cover exactly the dark modules', () => {
    const modules = stripeModules('BAT-9V');
    const { runs, modules: count } = stripeRuns('BAT-9V');
    expect(count).toBe(modules.length);
    expect(runs.reduce((sum, run) => sum + run.width, 0)).toBe(modules.filter(Boolean).length);
    for (const run of runs) for (let at = run.at; at < run.at + run.width; at += 1) expect(modules[at]).toBe(true);
  });
});

describe('the square', () => {
  it('is a QR code with its three corner marks', () => {
    const { size, dark } = qrModules('FLT-16251');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(dark).toHaveLength(size * size);
    // The top-left, top-right and bottom-left corners are dark; the bottom-right is not a corner mark.
    const at = (x: number, y: number) => dark[y * size + x];
    expect([at(0, 0), at(size - 1, 0), at(0, size - 1)]).toEqual([true, true, true]);
    expect(qrPath('FLT-16251').path.startsWith('M0 0h1v1h-1z')).toBe(true);
  });
});

describe('which label goes where', () => {
  it('prints each item as many times as asked, in the list\'s order', () => {
    expect(labelsOf(PICKS).map((label) => label.code)).toEqual([...Array(6).fill('FLT-16251'), 'BAT-9V', 'BAT-9V']);
    expect(labelsSummary(PICKS)).toBe('2 items, 8 labels');
    expect(labelsSummary([{ ...PICKS[1]!, copies: 1 }])).toBe('1 item, 1 label');
  });

  it('fills a sheet of thirty, then starts another', () => {
    const pages = labelPages([{ ...PICKS[0]!, copies: 31 }], 'SHEET');
    expect(pages.map((page) => page.length)).toEqual([30, 1]);
  });

  it('skips the labels already peeled off a partly used sheet', () => {
    const [sheet] = labelPages(PICKS, 'SHEET', 4);
    expect(sheet!.slice(0, 3)).toEqual([null, null, null]);
    expect(sheet![3]!.code).toBe('FLT-16251');
    expect(sheet).toHaveLength(11);
    // A start beyond the sheet is the last place, never a blank sheet.
    expect(labelPages(PICKS, 'SHEET', 99)[0]!.filter(Boolean)).toHaveLength(1);
  });

  it('gives a label printer one label a page, and never skips', () => {
    const pages = labelPages(PICKS, 'ROLL', 9);
    expect(pages).toHaveLength(8);
    expect(pages.every((page) => page.length === 1 && page[0] !== null)).toBe(true);
  });

  it('says why nothing can be printed', () => {
    expect(labelsProblem([])).toBe('Tick at least one item code.');
    expect(labelsProblem([{ ...PICKS[0]!, copies: 0 }])).toBe('Tick at least one item code.');
    expect(labelsProblem(Array.from({ length: 7 }, () => ({ ...PICKS[0]!, copies: 99 })))).toContain(`up to ${MOST_LABELS}`);
    expect(labelsProblem(PICKS)).toBeNull();
  });

  it('reads a typed number of copies, or refuses it', () => {
    expect(readCopies(' 6 ')).toBe(6);
    expect(readCopies('99')).toBe(99);
    for (const typed of ['', 'six', '1.5', '-1', '100']) expect(readCopies(typed)).toBeNull();
  });
});

describe('the PDF', () => {
  it('renders a sheet and a roll', async () => {
    const sheet = await renderToBuffer(<ItemLabelsDocument paper="SHEET" picks={PICKS} startAt={1} />);
    expect(sheet.subarray(0, 5).toString()).toBe('%PDF-');
    const roll = await renderToBuffer(<ItemLabelsDocument paper="ROLL" picks={PICKS} startAt={1} />);
    expect(roll.subarray(0, 5).toString()).toBe('%PDF-');
    // Eight pages of one label against one page of eight.
    expect((roll.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(8);
    expect((sheet.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(1);
  });

  it('renders the longest code an item may have', async () => {
    const pdf = await renderToBuffer(<ItemLabelsDocument paper="SHEET" picks={[{ code: 'A23456789-123456789-1234', name: 'A long one', unit: 'box', copies: 1 }]} startAt={1} />);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('keeps a long description to one line, and names the file by its paper', () => {
    expect(labelName({ name: 'Filter 16x25x1', unit: 'pcs' })).toBe('Filter 16x25x1 · pcs');
    expect(labelName({ name: 'A very long description of a filter that goes on', unit: 'pcs' })).toHaveLength(38);
    expect(labelsFileName('SHEET', 14)).toBe('Item labels sheet (14).pdf');
    expect(labelsFileName('ROLL', 2)).toBe('Item labels roll (2).pdf');
  });
});
