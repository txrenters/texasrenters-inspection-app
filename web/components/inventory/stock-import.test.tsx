import type { StockImportCheck } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StockImportDialog } from './stock-import';

const hooks = vi.hoisted(() => ({ useStockImport: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);
const files = vi.hoisted(() => ({ downloadImportTemplate: vi.fn(async () => undefined) }));
vi.mock('@/lib/stock-import/stock-import-file', async (actual) => ({ ...(await actual<object>()), downloadImportTemplate: files.downloadImportTemplate }));

const STOCK = {
  places: [{ id: 'place-store', name: 'Office Storeroom', code: 'STORE', kind: 'STOCKROOM', technicianId: null, technician: null, active: true, itemsHeld: 0 }],
  categories: [],
  units: [{ code: 'EA', name: 'each' }],
  companies: [{ tenantId: 'tenant-thmp', name: 'THMP' }],
  vendors: [],
} as never;

const mutation = (data?: unknown) => ({ mutate: vi.fn(), reset: vi.fn(), data, error: null, isPending: false });
const checked = (over: Partial<StockImportCheck> = {}): StockImportCheck => ({
  rows: [
    { line: 2, code: 'FLT-16251', item: 'EXISTING', place: 'Office Storeroom', quantity: 24, unitCostCents: 390, problems: [] },
    { line: 3, code: 'BAT-9V', item: 'NEW', place: 'Office Storeroom', quantity: 6, unitCostCents: 185, problems: [] },
  ],
  problems: [],
  newItems: 1,
  existingItems: 1,
  totalQuantity: 30,
  totalValueCents: 10470,
  ready: true,
  ...over,
});
const CSV = 'Item Code,Description,Category,Unit of Measure,Company,Location Code,Quantity,Unit Cost\r\nFLT-16251,,,,,STORE,24,3.90\r\nBAT-9V,"Battery, 9 V",Filters,each,THMP,STORE,6,1.85\r\n';
const choose = (text: string, name = 'stock.csv') => fireEvent.change(screen.getByLabelText('The file, filled in'), { target: { files: [new File([text], name, { type: 'text/csv' })] } });

// 2026-11-23, the office: the stock comes in from a spreadsheet, and nothing is saved until every row is right.
describe('Import stock', () => {
  let edits: { check: ReturnType<typeof mutation>; run: ReturnType<typeof mutation> };
  beforeEach(() => {
    edits = { check: mutation(), run: mutation() };
    hooks.useStockImport.mockImplementation(() => edits);
    files.downloadImportTemplate.mockClear();
  });

  it("offers the template, and checks the file chosen against the office, cells as text", async () => {
    render(<StockImportDialog onClose={vi.fn()} stock={STOCK} />);
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    expect(files.downloadImportTemplate).toHaveBeenCalledWith('xlsx', STOCK);
    choose(CSV);
    await waitFor(() => expect(edits.check.mutate).toHaveBeenCalled());
    const [input] = edits.check.mutate.mock.calls[0] as [{ rows: Record<string, unknown>[]; fileName: string; day: string }];
    expect(input.fileName).toBe('stock.csv');
    expect(input.rows.map((row) => [row.line, row.code, row.description, row.place, row.quantity, row.unitCost])).toEqual([
      [2, 'FLT-16251', '', 'STORE', '24', '3.90'],
      [3, 'BAT-9V', 'Battery, 9 V', 'STORE', '6', '1.85'],
    ]);
  });

  it('says why a file cannot be read, and sends nothing', async () => {
    render(<StockImportDialog onClose={vi.fn()} stock={STOCK} />);
    choose('Name,Qty\r\nFilter,3\r\n');
    expect(await screen.findByText(/No row names an "Item Code" column/)).toBeTruthy();
    expect(edits.check.mutate).not.toHaveBeenCalled();
  });

  it('lists the rows to fix and keeps Import off until every row is right', async () => {
    edits.check = mutation(
      checked({
        ready: false,
        rows: [
          { line: 2, code: 'FLT-16251', item: 'EXISTING', place: 'Office Storeroom', quantity: 24, unitCostCents: 390, problems: [] },
          { line: 3, code: 'GLU-1', item: 'NEW', place: 'Moon', quantity: 3, unitCostCents: 900, problems: ['"Moon" is not one of the places.', 'GLU-1 is new: give its category.'] },
        ],
      }),
    );
    render(<StockImportDialog onClose={vi.fn()} stock={STOCK} />);
    choose(CSV);
    const table = await screen.findByRole('table', { name: 'Rows to fix' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByRole('row', { name: /GLU-1/ }).textContent).toContain('"Moon" is not one of the places.');
    expect(screen.getByText(/Fix 1 row and choose it again/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Import/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('imports a right file once, by one key, and says what it brought in', async () => {
    edits.check = mutation(checked());
    const { rerender } = render(<StockImportDialog onClose={vi.fn()} stock={STOCK} />);
    choose(CSV);
    expect(await screen.findByText('Every row is right.')).toBeTruthy();
    expect(screen.getByText(/2 rows: 1 new item code, 1 already made, 30 on hand worth \$104\.70\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 rows' }));
    const [input] = edits.run.mutate.mock.calls[0] as [{ requestKey: string; rows: unknown[] }];
    expect(input.rows).toHaveLength(2);
    expect(input.requestKey).toMatch(/^[0-9a-f-]{36}$/);

    // What it brought in, once it is done.
    const onSuccess = (edits.run.mutate.mock.calls[0] as [unknown, { onSuccess: (done: unknown) => void }])[1].onSuccess;
    onSuccess({ rows: 2, newItems: 1, totalValueCents: 10470 });
    rerender(<StockImportDialog onClose={vi.fn()} stock={STOCK} />);
    expect(await screen.findByText('Imported 2 rows: $104.70 of stock.')).toBeTruthy();
    expect(screen.getByText(/1 new item code was made/)).toBeTruthy();
  });
});
