import type { StockCountChoices, StockCountDetail, StockCountLineRow, StockCountList, StockCountSummary } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StockCountPage from '@/app/(admin)/inventory/counts/[countId]/page';

import { CountsTab } from './counts-tab';

/** Inventory counts, phase 6 (2026-11-19). Every item, place, person and number invented. */

const hooks = vi.hoisted(() => ({ useStockCounts: vi.fn(), useStockCountChoices: vi.fn(), useStockCount: vi.fn(), useStockCountEdits: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ countId: 'count-1' }) }));

const summary = (over: Partial<StockCountSummary> = {}): StockCountSummary => ({
  id: 'count-1',
  number: 'CNT-0007',
  kind: 'MONTHLY',
  title: 'Monthly count, November 2026',
  status: 'OPEN',
  place: { id: 'place-stockroom', name: 'Stockroom' },
  day: '2026-11-19',
  lines: 3,
  counted: 0,
  countedBy: null,
  netValueCents: null,
  ...over,
});
const line = (over: Partial<StockCountLineRow> = {}): StockCountLineRow => ({
  id: 'line-filter',
  itemId: 'item-filter',
  itemCode: 'FLT-0003',
  itemName: 'Filter 20x25x1',
  unit: 'each',
  place: { id: 'place-stockroom', name: 'Stockroom' },
  counted: null,
  waiting: true,
  recount: false,
  expected: null,
  difference: null,
  valueCents: null,
  reason: null,
  ...over,
});
const battery = (over: Partial<StockCountLineRow> = {}) => line({ id: 'line-battery', itemId: 'item-battery', itemCode: 'PRT-0001', itemName: 'Battery, 9 V', ...over });
const glue = (over: Partial<StockCountLineRow> = {}) => line({ id: 'line-glue', itemId: 'item-glue', itemCode: 'PST-0001', itemName: 'Glue boards', unit: 'pack', ...over });
const NOBODY = { count: false, recount: false, post: false, cancel: false };
const detail = (over: Partial<StockCountDetail> = {}): StockCountDetail => ({
  ...summary(),
  note: null,
  startedBy: 'Sample Counter',
  startedAt: '2026-11-19T15:00:00.000Z',
  submittedAt: null,
  approvedBy: null,
  postedAt: null,
  cancelled: null,
  reviewing: false,
  matched: null,
  different: null,
  rows: [line(), battery(), glue()],
  can: { ...NOBODY, count: true, cancel: true },
  ...over,
});
/** Handed in, as somebody who approves sees it: one matched, one short, one over. */
const review = (over: Partial<StockCountDetail> = {}) =>
  detail({
    status: 'REVIEW',
    counted: 3,
    countedBy: 'Sample Counter',
    submittedAt: '2026-11-19T16:00:00.000Z',
    reviewing: true,
    matched: 1,
    different: 2,
    rows: [
      line({ counted: 38, waiting: false, expected: 40, difference: -2, valueCents: -800 }),
      battery({ counted: 6, waiting: false, expected: 6, difference: 0, valueCents: 0 }),
      glue({ counted: 15, waiting: false, expected: 14, difference: 1, valueCents: 910 }),
    ],
    can: { count: false, recount: true, post: true, cancel: true },
    ...over,
  });

const mutation = (answer: unknown = detail()) => ({ mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(async () => answer), isPending: false, error: null as Error | null, reset: vi.fn() });
let edits: Record<'start' | 'save' | 'handIn' | 'recount' | 'post' | 'cancel', ReturnType<typeof mutation>>;
const show = (count: StockCountDetail) => hooks.useStockCount.mockReturnValue({ isLoading: false, isError: false, data: count });
const pick = (label: string | RegExp, option: string | RegExp) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  router.push.mockReset();
  edits = { start: mutation(detail({ id: 'count-9' })), save: mutation(), handIn: mutation(), recount: mutation(), post: mutation(), cancel: mutation() };
  hooks.useStockCountEdits.mockReturnValue(edits);
  hooks.useStockCountChoices.mockReset();
});

describe('the Counts tab', () => {
  const list = (over: Partial<StockCountList> = {}): StockCountList => ({
    counts: [summary({ status: 'POSTED', counted: 3, countedBy: 'Sample Counter', netValueCents: -615 })],
    schedule: [
      { kind: 'MONTHLY', due: '2026-11-30', current: { id: 'count-1', number: 'CNT-0007', status: 'POSTED' }, lastPosted: { number: 'CNT-0007', day: '2026-11-19' } },
      { kind: 'QUARTERLY', due: '2026-12-31', current: null, lastPosted: null },
      { kind: 'YEARLY', due: '2026-12-31', current: null, lastPosted: null },
    ],
    ...over,
  });
  const choices: StockCountChoices = {
    places: [
      { id: 'place-stockroom', name: 'Stockroom' },
      { id: 'place-van', name: 'Van 1' },
    ],
    items: [
      { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1' },
      { id: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V' },
      { id: 'item-glue', code: 'PST-0001', name: 'Glue boards' },
    ],
    fastMovers: [
      { placeId: 'place-stockroom', itemId: 'item-filter' },
      { placeId: 'place-van', itemId: 'item-battery' },
    ],
  };

  it('says when each kind is next due, opens this period\'s count, and lists the counts', () => {
    hooks.useStockCounts.mockReturnValue({ isError: false, data: list() });
    render(<CountsTab canCount />);

    const monthly = screen.getByRole('article', { name: 'Monthly count' });
    expect(monthly.textContent).toContain('Due Mon, Nov 30');
    expect(monthly.textContent).toContain('last posted Thu, Nov 19 (CNT-0007)');
    expect(within(monthly).getByRole('link', { name: 'Open CNT-0007' }).getAttribute('href')).toBe('/inventory/counts/count-1');
    const yearly = screen.getByRole('article', { name: 'Yearly count' });
    expect(yearly.textContent).toContain('Not started');
    expect(yearly.textContent).toContain('Stock is frozen');

    const row = within(screen.getByRole('table', { name: 'Inventory counts' })).getByRole('row', { name: /CNT-0007/ });
    for (const words of ['Monthly count, November 2026', 'Stockroom', '3 of 3', 'Sample Counter', '-$6.15', 'Posted']) expect(row.textContent).toContain(words);
    // The form's choices are not read until it is opened.
    expect(hooks.useStockCountChoices).not.toHaveBeenCalled();
  });

  it('starts a monthly count of a place with its fast movers ticked, and opens it', async () => {
    hooks.useStockCounts.mockReturnValue({ isError: false, data: list() });
    hooks.useStockCountChoices.mockReturnValue({ isError: false, data: choices });
    render(<CountsTab canCount />);
    fireEvent.click(button('Start the quarterly count'));

    const dialog = screen.getByRole('dialog', { name: 'Start a count' });
    expect(within(dialog).getByText('Choose the place to count.')).toBeTruthy();
    pick('Which count', 'Monthly');
    pick('Place to count', 'Stockroom');
    expect((within(dialog).getByRole('checkbox', { name: /FLT-0003/ }) as HTMLInputElement).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog).getByRole('checkbox', { name: /PRT-0001/ }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /PST-0001/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start the count' }));

    await waitFor(() => expect(edits.start.mutateAsync).toHaveBeenCalledTimes(1));
    expect(edits.start.mutateAsync.mock.calls[0]![0]).toEqual({ kind: 'MONTHLY', placeId: 'place-stockroom', itemIds: ['item-filter', 'item-glue'], note: null, requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/inventory/counts/count-9'));
  });

  it('warns that a yearly count holds stock still, and asks for no place', async () => {
    hooks.useStockCounts.mockReturnValue({ isError: false, data: list() });
    hooks.useStockCountChoices.mockReturnValue({ isError: false, data: choices });
    render(<CountsTab canCount />);
    fireEvent.click(button('Start the yearly count'));

    const dialog = screen.getByRole('dialog', { name: 'Start a count' });
    expect(dialog.textContent).toContain('nothing can be received, taken out, returned or moved');
    expect(within(dialog).queryByLabelText('Place to count')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start the count' }));
    await waitFor(() => expect(edits.start.mutateAsync.mock.calls[0]![0]).toMatchObject({ kind: 'YEARLY', placeId: null, itemIds: [] }));
  });

  it('offers nobody a count to start who may not count', () => {
    hooks.useStockCounts.mockReturnValue({ isError: false, data: list({ counts: [] }) });
    render(<CountsTab canCount={false} />);
    expect(screen.queryByRole('button', { name: /Start/ })).toBeNull();
    expect(screen.getByText('No counts yet')).toBeTruthy();
  });
});

describe('counting', () => {
  it('shows the items and a box each, with no expected number anywhere', () => {
    show(detail());
    render(<StockCountPage />);

    expect(screen.getByRole('heading', { name: 'Monthly count, November 2026' })).toBeTruthy();
    const table = screen.getByRole('table', { name: 'What to count' });
    expect(within(table).getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByText('Expected')).toBeNull();
    expect(screen.queryByText('Difference')).toBeNull();
    expect(button('Hand in the count').disabled).toBe(true);
    expect(screen.getByText('3 still to count.')).toBeTruthy();
  });

  it('jumps to the line a scanned label names, and Enter in a count goes back for the next label, never handing in (2026-11-19)', () => {
    show(detail());
    render(<StockCountPage />);
    const scan = screen.getByLabelText('Scan or type an item code') as HTMLInputElement;

    fireEvent.change(scan, { target: { value: 'prt-0001' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    const counted = screen.getByLabelText('Counted Battery, 9 V');
    expect(document.activeElement).toBe(counted);
    expect(counted.closest('tr')?.getAttribute('data-scanned')).toBe('true');

    fireEvent.change(counted, { target: { value: '12' } });
    expect(fireEvent.keyDown(counted, { key: 'Enter' })).toBe(false);
    expect(document.activeElement).toBe(scan);
    expect(edits.handIn.mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(scan, { target: { value: 'XYZ-999' } });
    fireEvent.keyDown(scan, { key: 'Enter' });
    expect(screen.getByText('XYZ-999 is not in this count.')).toBeTruthy();
  });

  it('saves progress with what is typed so far, and hands in only when every item is counted', async () => {
    show(detail());
    render(<StockCountPage />);
    fireEvent.change(screen.getByLabelText('Counted Filter 20x25x1'), { target: { value: '38' } });
    fireEvent.change(screen.getByLabelText('Counted Battery, 9 V'), { target: { value: '1.5' } });
    expect(screen.getByText('A count is a whole number, 0 or more.')).toBeTruthy();
    expect(button('Save progress').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Counted Battery, 9 V'), { target: { value: '' } });

    fireEvent.click(button('Save progress'));
    await waitFor(() =>
      expect(edits.save.mutateAsync).toHaveBeenCalledWith({
        countId: 'count-1',
        input: { lines: [{ lineId: 'line-filter', counted: 38 }, { lineId: 'line-battery', counted: null }, { lineId: 'line-glue', counted: null }] },
      }),
    );
    expect(edits.handIn.mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Counted Battery, 9 V'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Counted Glue boards'), { target: { value: '0' } });
    fireEvent.click(button('Hand in the count'));
    await waitFor(() => expect(edits.handIn.mutateAsync).toHaveBeenCalledTimes(1));
    expect(edits.handIn.mutateAsync.mock.calls[0]![0]).toMatchObject({ input: { lines: [{ counted: 38 }, { counted: 6 }, { counted: 0 }] } });
  });

  it('opens only the lines sent back for a second count', async () => {
    show(detail({ status: 'COUNTING', counted: 2, countedBy: 'Sample Counter', rows: [line({ recount: true }), battery({ counted: 6, waiting: false }), glue({ counted: 15, waiting: false })] }));
    render(<StockCountPage />);

    expect(screen.getByText(/1 item needs a second count/)).toBeTruthy();
    expect(screen.getByText('Count this one again.')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'What to count' })).getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Counted Filter 20x25x1'), { target: { value: '39' } });
    fireEvent.click(button('Hand in the count'));
    await waitFor(() => expect(edits.handIn.mutateAsync).toHaveBeenCalledWith({ countId: 'count-1', input: { lines: [{ lineId: 'line-filter', counted: 39 }] } }));
  });

  it('empties the box of a line sent back, so the second count is typed afresh', () => {
    show(detail({ status: 'COUNTING', counted: 1, countedBy: 'Sample Counter', rows: [line({ counted: 8 }), battery(), glue()] }));
    const { rerender } = render(<StockCountPage />);
    expect((screen.getByLabelText('Counted Filter 20x25x1') as HTMLInputElement).value).toBe('8');

    // Handed in: the filter was far out and waits again; the others stay as counted.
    show(detail({ status: 'COUNTING', counted: 2, countedBy: 'Sample Counter', rows: [line({ recount: true }), battery({ counted: 6, waiting: false }), glue({ counted: 15, waiting: false })] }));
    rerender(<StockCountPage />);
    expect((screen.getByLabelText('Counted Filter 20x25x1') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('1 still to count.')).toBeTruthy();
    expect(button('Hand in the count').disabled).toBe(true);
  });

  it('shows the counter only what was counted once it is handed in', () => {
    show(detail({ status: 'REVIEW', counted: 3, countedBy: 'Sample Counter', submittedAt: '2026-11-19T16:00:00.000Z', rows: [line({ counted: 38, waiting: false }), battery({ counted: 6, waiting: false }), glue({ counted: 15, waiting: false })], can: NOBODY }));
    render(<StockCountPage />);

    expect(screen.getByText(/Handed in\. Somebody who approves counts/)).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'What was counted' })).getByRole('row', { name: /Filter 20x25x1/ }).textContent).toContain('38');
    expect(screen.queryByText('Expected')).toBeNull();
    expect(screen.queryByRole('button', { name: /Approve|Hand in|Cancel count/ })).toBeNull();
  });
});

describe('reviewing', () => {
  it('shows what differed, at what it is worth, and posts once each difference has a reason that fits it', async () => {
    show(review());
    render(<StockCountPage />);

    expect(screen.getByText('1 of 3 matched. The 2 that did not are below.')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Differences' });
    expect(within(table).queryByText('Battery, 9 V')).toBeNull();
    const filter = within(table).getByRole('row', { name: /Filter 20x25x1/ });
    for (const words of ['40', '38', '2 short', '-$8.00']) expect(filter.textContent).toContain(words);
    expect(within(table).getByRole('row', { name: /Glue boards/ }).textContent).toContain('1 over');
    expect(within(table).getByRole('row', { name: /Net difference/ }).textContent).toContain('$1.10');
    expect(button('Approve and post').disabled).toBe(true);
    expect(screen.getByText('Give each of the 2 differences a reason.')).toBeTruthy();

    // Nothing short was "returned"; nothing over was "damaged".
    fireEvent.keyDown(screen.getByLabelText('Reason for Filter 20x25x1'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: 'Returned without a return' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Taken without a withdrawal' }));
    fireEvent.keyDown(screen.getByLabelText('Reason for Glue boards'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: 'Damaged' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Returned without a return' }));

    fireEvent.click(button('Approve and post'));
    await waitFor(() =>
      expect(edits.post.mutateAsync).toHaveBeenCalledWith({
        countId: 'count-1',
        input: { reasons: [{ lineId: 'line-filter', reason: 'TAKEN_WITHOUT_WITHDRAWAL' }, { lineId: 'line-glue', reason: 'RETURNED_WITHOUT_RETURN' }] },
      }),
    );
  });

  it('shows every line when asked, and asks for a second count of one', async () => {
    show(review());
    render(<StockCountPage />);
    fireEvent.click(button('Show every line'));
    expect(within(screen.getByRole('table', { name: 'Differences' })).getByRole('row', { name: /Battery, 9 V/ }).textContent).toContain('Matches');

    fireEvent.click(button('Ask for a second count of Glue boards'));
    await waitFor(() => expect(edits.recount.mutateAsync).toHaveBeenCalledWith({ countId: 'count-1', lineId: 'line-glue' }));
  });

  it('posts a count that matched with nothing to explain', async () => {
    show(review({ matched: 3, different: 0, rows: [line({ counted: 40, waiting: false, expected: 40, difference: 0, valueCents: 0 }), battery({ counted: 6, waiting: false, expected: 6, difference: 0, valueCents: 0 }), glue({ counted: 14, waiting: false, expected: 14, difference: 0, valueCents: 0 })] }));
    render(<StockCountPage />);
    expect(screen.getByText('All 3 matched what the console has.')).toBeTruthy();
    fireEvent.click(button('Approve and post'));
    await waitFor(() => expect(edits.post.mutateAsync).toHaveBeenCalledWith({ countId: 'count-1', input: { reasons: [] } }));
  });

  it('waits for a second count before it can be posted', () => {
    show(review({ status: 'COUNTING', counted: 2, rows: [line({ recount: true }), battery({ counted: 6, waiting: false, expected: 6, difference: 0, valueCents: 0 }), glue({ counted: 15, waiting: false, expected: 14, difference: 1, valueCents: 910 })], can: { ...NOBODY, cancel: true } }));
    render(<StockCountPage />);
    expect(screen.getByText(/1 item is waiting for a second count/)).toBeTruthy();
    expect(screen.getByText('Waiting for the second count')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and post' })).toBeNull();
  });

  it('shows a posted count with its reasons and who approved, and nothing left to press', () => {
    show(review({ status: 'POSTED', approvedBy: 'Sample Manager', postedAt: '2026-11-19T17:00:00.000Z', netValueCents: 110, rows: [line({ counted: 38, waiting: false, expected: 40, difference: -2, valueCents: -800, reason: 'DAMAGED' })], lines: 1, matched: 0, different: 1, can: NOBODY }));
    render(<StockCountPage />);
    expect(within(screen.getByRole('table', { name: 'Differences' })).getByRole('row', { name: /Filter 20x25x1/ }).textContent).toContain('Damaged');
    expect(screen.getByText('Approved by').closest('tr, div')?.parentElement?.textContent).toContain('Sample Manager');
    expect(screen.queryByRole('button', { name: /Approve|Recount|Cancel count/ })).toBeNull();
  });

  it('cancels with a reason', async () => {
    show(review());
    render(<StockCountPage />);
    fireEvent.click(button('Cancel count'));
    const dialog = screen.getByRole('dialog', { name: 'Cancel CNT-0007?' });
    const confirm = within(dialog).getByRole('button', { name: 'Cancel count' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' wrong place ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(edits.cancel.mutateAsync).toHaveBeenCalledWith({ countId: 'count-1', input: { reason: 'wrong place' } }));
  });
});
