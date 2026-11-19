import type { StockItemRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrintLabels } from './print-labels';
import { ScanField, scannedItem } from './scan-field';

/** Bar codes in the console (2026-11-19). Every item invented. */

const download = vi.hoisted(() => ({ downloadLabels: vi.fn(async () => undefined) }));
vi.mock('@/lib/item-labels/download-labels', () => download);

const item = (over: Partial<StockItemRow> = {}): StockItemRow => ({
  id: 'item-filter',
  code: 'FLT-16251',
  name: 'Filter 16x25x1',
  unit: 'pcs',
  category: { id: 'cat-filters', name: 'Filters' },
  company: null,
  reorderLevel: 24,
  reorderQuantity: 48,
  usualVendor: null,
  priceCents: 342,
  active: true,
  onHand: 27,
  inStockrooms: 18,
  inVans: 9,
  valueCents: 9234,
  status: 'ENOUGH',
  ...over,
});
const ITEMS = [item(), item({ id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V' }), item({ id: 'item-old', code: 'OLD-0003', name: 'Discontinued filter', active: false })];

beforeEach(() => download.downloadLabels.mockClear());

describe('a scan', () => {
  it('names an item by its whole code, forgiving capitals and spaces', () => {
    expect(scannedItem(ITEMS, ' flt-16251 ')?.id).toBe('item-filter');
    expect(scannedItem(ITEMS, 'FLT-1625')).toBeNull();
    expect(scannedItem(ITEMS, '')).toBeNull();
  });

  it('acts on Enter, as a scanner device presses it, then empties for the next label', () => {
    const onItem = vi.fn();
    render(<ScanField id="scan" items={ITEMS} onItem={onItem} />);
    const field = screen.getByLabelText('Scan or type an item code') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'bat-9v' } });
    expect(onItem).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onItem).toHaveBeenCalledWith(ITEMS[1]);
    expect(field.value).toBe('');
    expect(screen.getByText('BAT-9V found.')).toBeTruthy();
  });

  it('says so when no item has the code, or when the screen will not take it', () => {
    const onItem = vi.fn(() => 'FLT-16251 is not in that place.');
    render(<ScanField id="scan" items={ITEMS} onItem={onItem} />);
    const field = screen.getByLabelText('Scan or type an item code');
    fireEvent.change(field, { target: { value: 'XYZ-999' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('No item has the code XYZ-999.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'FLT-16251' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('FLT-16251 is not in that place.')).toBeTruthy();
  });

  it('never submits the form it sits in', () => {
    const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={submitted}>
        <ScanField id="scan" items={ITEMS} onItem={() => undefined} />
      </form>,
    );
    const field = screen.getByLabelText('Scan or type an item code');
    fireEvent.change(field, { target: { value: 'FLT-16251' } });
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });
});

describe('printing labels', () => {
  const mount = () => {
    const onBack = vi.fn();
    render(<PrintLabels items={ITEMS} onBack={onBack} />);
    return { onBack, make: screen.getByRole('button', { name: 'Make the PDF' }) as HTMLButtonElement };
  };

  it('offers the codes in use, and prints nothing until one is ticked', () => {
    const { make } = mount();
    const table = screen.getByRole('table', { name: 'Item codes to print' });
    expect(within(table).queryByText('OLD-0003')).toBeNull();
    expect(make.disabled).toBe(true);
    expect(screen.getByText('Tick at least one item code.')).toBeTruthy();
    // The preview draws both bar codes of the first item.
    expect(screen.getByRole('img', { name: 'Striped bar code for FLT-16251' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR code for FLT-16251' })).toBeTruthy();
  });

  it('makes a sheet of what was ticked, as many of each as typed, from the label said', async () => {
    const { make } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Print FLT-16251' }));
    fireEvent.change(screen.getByLabelText('Labels for FLT-16251'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Print BAT-9V' }));
    fireEvent.change(screen.getByLabelText('Start at label'), { target: { value: '4' } });
    expect(screen.getByText('2 items, 7 labels')).toBeTruthy();
    fireEvent.click(make);
    await waitFor(() =>
      expect(download.downloadLabels).toHaveBeenCalledWith(
        [
          { code: 'FLT-16251', name: 'Filter 16x25x1', unit: 'pcs', copies: 6 },
          { code: 'BAT-9V', name: 'Battery, 9 V', unit: 'pcs', copies: 1 },
        ],
        'SHEET',
        4,
      ),
    );
  });

  it('ticks every code in use at once, and goes back', () => {
    const { onBack } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Tick all' }));
    expect(screen.getByText('2 items, 2 labels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to item codes' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('refuses a number of labels or a starting place that is not one', () => {
    const { make } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Print FLT-16251' }));
    fireEvent.change(screen.getByLabelText('Labels for FLT-16251'), { target: { value: '0' } });
    expect(screen.getByText('Say how many labels of FLT-16251: 1 to 99.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Labels for FLT-16251'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Start at label'), { target: { value: '31' } });
    expect(screen.getByText('Start at a label from 1 to 30.')).toBeTruthy();
    expect(make.disabled).toBe(true);
    expect(download.downloadLabels).not.toHaveBeenCalled();
  });

  it('says so when the PDF could not be made', async () => {
    download.downloadLabels.mockRejectedValueOnce(new Error('no'));
    const { make } = mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Print BAT-9V' }));
    fireEvent.click(make);
    expect(await screen.findByText('The labels could not be made. Try again.')).toBeTruthy();
  });
});
