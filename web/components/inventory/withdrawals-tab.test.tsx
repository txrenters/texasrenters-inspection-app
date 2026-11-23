import type { StockSlipChoices, StockSlipRow, TruckAsk } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WithdrawalsTab } from './withdrawals-tab';

/** Withdrawals, returns and moves, phase 5 (2026-11-19). Every item, place, person and visit invented. */

const hooks = vi.hoisted(() => ({ useStockSlips: vi.fn(), useStockSlipChoices: vi.fn(), useStockSlipEdits: vi.fn(), useTruckAsks: vi.fn(), useTruckKeepLevels: vi.fn(), useTruckKeepEdits: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);

const choices = (over: Partial<StockSlipChoices> = {}): StockSlipChoices => ({
  technicians: [
    { id: 'tech-ana', name: 'Ana Sample' },
    { id: 'tech-ben', name: 'Ben Sample' },
  ],
  places: [
    { id: 'place-stockroom', name: 'Stockroom', kind: 'STOCKROOM', technicianId: null },
    { id: 'place-van', name: 'Van 1', kind: 'VAN', technicianId: 'tech-ana' },
  ],
  items: [
    { id: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' },
    { id: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' },
  ],
  levels: [
    { itemId: 'item-filter', placeId: 'place-stockroom', quantity: 40 },
    { itemId: 'item-filter', placeId: 'place-van', quantity: 10 },
    { itemId: 'item-battery', placeId: 'place-stockroom', quantity: 1 },
  ],
  visits: [],
  day: '2026-11-19',
  ...over,
});
const slip = (over: Partial<StockSlipRow> = {}): StockSlipRow => ({
  id: 'slip-1',
  number: 'WD-0031',
  kind: 'WITHDRAWAL',
  day: '2026-11-19',
  technician: { id: 'tech-ana', name: 'Ana Sample' },
  from: { id: 'place-stockroom', name: 'Stockroom' },
  to: null,
  visit: { id: 'visit-1', title: 'HVAC filter change', address: '100 Sample St' },
  note: null,
  lines: [{ itemCode: 'FLT-0003', itemName: 'Filter 20x25x1', quantity: 4, unitCostCents: 400 }],
  costCents: 1600,
  by: 'Office Coordinator',
  at: '2026-11-19T15:00:00.000Z',
  reversed: null,
  ...over,
});

const mutation = (answer: unknown = { slips: [slip()] }) => ({ mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(async () => answer), isPending: false, error: null as Error | null, reset: vi.fn() });
let post: ReturnType<typeof mutation>;
let reverse: ReturnType<typeof mutation>;

const pick = (label: string | RegExp, option: string | RegExp) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const postButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  post = mutation();
  reverse = mutation();
  hooks.useStockSlipEdits.mockReturnValue({ post, reverse });
  hooks.useStockSlips.mockReturnValue({ isError: false, data: { slips: [] } });
  // No truck waits on an ask unless a test says so (2026-11-24).
  hooks.useTruckAsks.mockReturnValue({ isError: false, data: { asks: [] } });
  hooks.useStockSlipChoices.mockReset();
  // The chosen technician's visits come with the technician, as the server sends them.
  hooks.useStockSlipChoices.mockImplementation((_enabled: boolean, technicianId: string | null) => ({
    isError: false,
    data: choices({ visits: technicianId === 'tech-ana' ? [{ id: 'visit-1', title: 'HVAC filter change', address: '100 Sample St' }] : [] }),
  }));
});

describe('recording a withdrawal', () => {
  it('says what is missing, shows what is on hand in the place, and posts the whole slip once', async () => {
    render(<WithdrawalsTab canWithdraw />);

    expect(postButton('Post withdrawal').disabled).toBe(true);
    expect(screen.getByText('Say who is taking it.')).toBeTruthy();
    pick('Who is taking it', 'Ana Sample');
    expect(hooks.useStockSlipChoices).toHaveBeenLastCalledWith(true, 'tech-ana');
    expect(screen.getByText('Choose where it is taken from.')).toBeTruthy();
    pick('Taken from', 'Stockroom');
    expect(screen.getByText('Add at least one item.')).toBeTruthy();

    pick('Item 1', /FLT-0003/);
    expect(within(screen.getByRole('table', { name: 'Items on the slip' })).getByText('40 each')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Quantity of Filter 20x25x1'), { target: { value: '41' } });
    expect(screen.getByText('Only 40 of FLT-0003 are there.')).toBeTruthy();
    expect(postButton('Post withdrawal').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Quantity of Filter 20x25x1'), { target: { value: '4' } });

    pick('For the visit', /HVAC filter change, 100 Sample St/);
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' upstairs unit ' } });
    fireEvent.click(postButton('Post withdrawal'));

    await waitFor(() => expect(post.mutateAsync).toHaveBeenCalledTimes(1));
    expect(post.mutateAsync.mock.calls[0]![0]).toEqual({
      kind: 'WITHDRAWAL',
      technicianId: 'tech-ana',
      fromPlaceId: 'place-stockroom',
      toPlaceId: null,
      inspectionId: 'visit-1',
      note: 'upstairs unit',
      requestKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lines: [{ itemId: 'item-filter', quantity: 4 }],
      askId: null,
    });
    // The form is ready for the next slip, which is a new one.
    expect(await screen.findByText('WD-0031 is posted.')).toBeTruthy();
    expect((screen.getByLabelText('Quantity of Item 1') as HTMLInputElement).value).toBe('');
  });

  it('offers an item once, and refuses a quantity that is not a whole number', () => {
    render(<WithdrawalsTab canWithdraw />);
    pick('Who is taking it', 'Ana Sample');
    pick('Taken from', 'Stockroom');
    pick('Item 1', /FLT-0003/);
    fireEvent.change(screen.getByLabelText('Quantity of Filter 20x25x1'), { target: { value: '1.5' } });
    expect(screen.getByText('Give each item a whole number of units.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.keyDown(screen.getByLabelText('Item 2'), { key: 'ArrowDown' });
    expect(screen.queryByRole('option', { name: /FLT-0003/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /PRT-0001/ }));
    // Two items are all there are.
    expect((screen.getByRole('button', { name: 'Add item' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Battery, 9 V' }));
    expect(screen.queryByLabelText('Item 2')).toBeNull();
  });

  it('shows what the server refused and keeps the slip as typed', async () => {
    post.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    post.error = new Error('Somebody has just taken some of that stock. Open the tab again to see what is there.');
    render(<WithdrawalsTab canWithdraw />);
    pick('Who is taking it', 'Ana Sample');
    pick('Taken from', 'Stockroom');
    pick('Item 1', /FLT-0003/);
    fireEvent.change(screen.getByLabelText('Quantity of Filter 20x25x1'), { target: { value: '4' } });
    fireEvent.click(postButton('Post withdrawal'));

    await waitFor(() => expect(post.mutateAsync).toHaveBeenCalled());
    expect(screen.getByText(/Somebody has just taken/)).toBeTruthy();
    expect((screen.getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('4');
  });
});

describe('scanning onto a slip (2026-11-19)', () => {
  const scan = (code: string) => {
    const field = screen.getByLabelText('Scan or type an item code');
    fireEvent.change(field, { target: { value: code } });
    fireEvent.keyDown(field, { key: 'Enter' });
  };

  it('puts the item on the slip at one, and a second scan makes it two', () => {
    render(<WithdrawalsTab canWithdraw />);
    scan('FLT-0003');
    expect((screen.getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('1');
    scan('flt-0003');
    expect((screen.getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('2');
    // Another item gets a row of its own.
    scan('PRT-0001');
    expect((screen.getByLabelText('Quantity of Battery, 9 V') as HTMLInputElement).value).toBe('1');
    expect(post.mutateAsync).not.toHaveBeenCalled();
  });

  it('says so, and adds nothing, for a code no item has', () => {
    render(<WithdrawalsTab canWithdraw />);
    scan('XYZ-999');
    expect(screen.getByText('No item has the code XYZ-999.')).toBeTruthy();
    expect(screen.queryByLabelText('Quantity of Filter 20x25x1')).toBeNull();
  });
});

describe('a return and a move', () => {
  it('brings stock back into a place without asking what is there', async () => {
    render(<WithdrawalsTab canWithdraw />);
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
    expect(screen.queryByLabelText('Taken from')).toBeNull();
    pick('Who is bringing it back', 'Ben Sample');
    pick('Put back in', 'Stockroom');
    pick('Item 1', /PRT-0001/);
    expect(screen.queryByText('On hand there')).toBeNull();
    fireEvent.change(screen.getByLabelText('Quantity of Battery, 9 V'), { target: { value: '5' } });
    fireEvent.click(postButton('Post return'));

    await waitFor(() => expect(post.mutateAsync).toHaveBeenCalled());
    expect(post.mutateAsync.mock.calls[0]![0]).toMatchObject({ kind: 'RETURN', technicianId: 'tech-ben', fromPlaceId: null, toPlaceId: 'place-stockroom', inspectionId: null, note: null, lines: [{ itemId: 'item-battery', quantity: 5 }] });
  });

  it('moves stock between two different places, with nobody and no visit on it', async () => {
    render(<WithdrawalsTab canWithdraw />);
    fireEvent.click(screen.getByRole('button', { name: 'Move between places' }));
    expect(screen.queryByLabelText(/^Who/)).toBeNull();
    expect(screen.queryByLabelText('For the visit')).toBeNull();
    pick('Taken from', 'Stockroom');
    pick('Moved to', 'Stockroom');
    expect(screen.getByText('Choose two different places.')).toBeTruthy();
    pick('Moved to', 'Van 1');
    pick('Item 1', /FLT-0003/);
    fireEvent.change(screen.getByLabelText('Quantity of Filter 20x25x1'), { target: { value: '12' } });
    fireEvent.click(postButton('Post move'));

    await waitFor(() => expect(post.mutateAsync).toHaveBeenCalled());
    expect(post.mutateAsync.mock.calls[0]![0]).toMatchObject({ kind: 'TRANSFER', technicianId: null, fromPlaceId: 'place-stockroom', toPlaceId: 'place-van', inspectionId: null });
    expect(hooks.useStockSlipChoices).toHaveBeenLastCalledWith(true, null);
  });
});

describe('the latest slips', () => {
  const SLIPS = [
    slip(),
    slip({ id: 'slip-2', number: 'TR-0012', kind: 'TRANSFER', technician: null, to: { id: 'place-van', name: 'Van 1' }, visit: null, costCents: 4800 }),
    slip({ id: 'slip-3', number: 'RT-0004', kind: 'RETURN', from: null, to: { id: 'place-stockroom', name: 'Stockroom' }, visit: null, reversed: { by: 'Office Coordinator', at: '2026-11-19T16:00:00.000Z', reason: 'entered twice' } }),
  ];

  it('lists who took what, from where, for which visit and at what cost', () => {
    hooks.useStockSlips.mockReturnValue({ isError: false, data: { slips: SLIPS } });
    render(<WithdrawalsTab canWithdraw />);

    const table = screen.getByRole('table', { name: 'Withdrawals, returns and moves' });
    const withdrawal = within(table).getByRole('row', { name: /WD-0031/ });
    for (const words of ['Withdrawal', '4 × FLT-0003 Filter 20x25x1', 'Ana Sample', 'Stockroom', 'HVAC filter change', '100 Sample St', '$16.00']) expect(withdrawal.textContent).toContain(words);
    expect(within(table).getByRole('row', { name: /TR-0012/ }).textContent).toContain('Van 1');
    const returned = within(table).getByRole('row', { name: /RT-0004/ });
    expect(returned.textContent).toContain('Reversed by Office Coordinator: entered twice');
    expect(within(returned).queryByRole('button', { name: /Reverse/ })).toBeNull();
  });

  it('reverses a slip with a reason', async () => {
    hooks.useStockSlips.mockReturnValue({ isError: false, data: { slips: SLIPS } });
    render(<WithdrawalsTab canWithdraw />);
    fireEvent.click(screen.getByRole('button', { name: 'Reverse WD-0031' }));

    const dialog = screen.getByRole('dialog', { name: 'Reverse WD-0031?' });
    expect(dialog.textContent).toContain('This puts the stock back in Stockroom.');
    const confirm = within(dialog).getByRole('button', { name: 'Reverse slip' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Why'), { target: { value: ' wrong technician ' } });
    fireEvent.click(confirm);

    await waitFor(() => expect(reverse.mutateAsync).toHaveBeenCalledWith({ slipId: 'slip-1', input: { reason: 'wrong technician' } }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is read-only for somebody who may not record: no form, no reversing, and the form\'s choices are not asked for', () => {
    hooks.useStockSlips.mockReturnValue({ isError: false, data: { slips: SLIPS } });
    render(<WithdrawalsTab canWithdraw={false} />);

    expect(screen.queryByRole('form', { name: 'Record a slip' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reverse/ })).toBeNull();
    expect(screen.getByText('WD-0031')).toBeTruthy();
    // Asked for with the read switched off: nothing is read (2026-11-24, the asks panel holds the hook).
    expect(hooks.useStockSlipChoices.mock.calls.every(([enabled]) => !enabled)).toBe(true);
  });

  it('says so when there are none yet', () => {
    render(<WithdrawalsTab canWithdraw={false} />);
    expect(screen.getByText('No slips yet')).toBeTruthy();
  });
});

// Asks from the trucks (the office, 2026-11-24): filled with a move from the Storeroom.
describe('an ask from a truck', () => {
  const ask = (over: Partial<TruckAsk> = {}): TruckAsk => ({
    id: 'ask-1',
    place: { id: 'place-van', name: 'Van 1' },
    askedBy: { id: 'tech-ana', name: 'Ana Sample' },
    at: '2026-11-24T16:40:00.000Z',
    note: 'I can pick up Wednesday morning',
    status: 'ASKED',
    lines: [
      { itemId: 'item-filter', code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', quantity: 4 },
      { itemId: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each', quantity: 5 },
    ],
    filled: null,
    ...over,
  });

  it('is filled from the Storeroom into its truck, as much as the Storeroom has, and posting the move fills it', async () => {
    hooks.useTruckAsks.mockReturnValue({ isError: false, data: { asks: [ask(), ask({ id: 'ask-0', status: 'FILLED', filled: { slipNumber: 'TR-0019', at: '2026-11-21T15:00:00.000Z', by: 'Office Coordinator' } })] } });
    render(<WithdrawalsTab canWithdraw />);

    const asks = screen.getByRole('table', { name: 'Asks from the trucks' });
    expect(within(asks).getAllByRole('row')).toHaveLength(2);
    expect(within(asks).getByRole('row', { name: /Van 1/ }).textContent).toContain('4 × FLT-0003, 5 × PRT-0001');
    fireEvent.click(within(asks).getByRole('button', { name: "Fill Ana Sample's ask from the Storeroom" }));

    expect(screen.getByText("Filling Ana Sample's ask for Van 1.")).toBeTruthy();
    expect(screen.getByText(/PRT-0001: 1 of 5 in Stockroom/)).toBeTruthy();
    fireEvent.click(postButton('Post move'));
    await waitFor(() => expect(post.mutateAsync).toHaveBeenCalledTimes(1));
    expect(post.mutateAsync.mock.calls[0]![0]).toMatchObject({
      kind: 'TRANSFER',
      fromPlaceId: 'place-stockroom',
      toPlaceId: 'place-van',
      lines: [
        { itemId: 'item-filter', quantity: 4 },
        { itemId: 'item-battery', quantity: 1 },
      ],
      askId: 'ask-1',
    });
  });

  it('shows the waiting asks to somebody who may only look, with nothing to fill', () => {
    hooks.useTruckAsks.mockReturnValue({ isError: false, data: { asks: [ask()] } });
    render(<WithdrawalsTab canWithdraw={false} />);
    expect(screen.getByRole('table', { name: 'Asks from the trucks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Fill/ })).toBeNull();
  });
});
