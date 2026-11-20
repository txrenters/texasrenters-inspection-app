import { CODE_LISTS, DEFAULT_CODE_KEEPERS, DEFAULT_PAGE_LAYOUT, type PurchasingSetup, type RequisitionPageLayout } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodesSection, PageSection } from './setup-codes-page';

/**
 * Purchasing Setup, part 5c (2026-11-21): who keeps each code list, and the
 * requisition page's fields and FactBoxes. Saved as each change is made.
 * Every count invented.
 */

const hooks = vi.hoisted(() => ({ usePurchasingSetupEdits: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const SETUP = {
  codes: CODE_LISTS.map((list, index) => ({ list: list.key, keeper: DEFAULT_CODE_KEEPERS[list.key], inUse: index + 2 })),
  page: DEFAULT_PAGE_LAYOUT,
} as unknown as PurchasingSetup;
let saves: Record<'codes' | 'page', { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null }>;

beforeEach(() => {
  saves = { codes: { mutate: vi.fn(), isPending: false, error: null }, page: { mutate: vi.fn(), isPending: false, error: null } };
  hooks.usePurchasingSetupEdits.mockReturnValue(saves);
});

const pick = (label: string, option: string) => {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const lastPage = () => saves.page.mutate.mock.lastCall![0] as RequisitionPageLayout;

describe('Codes, and who makes them', () => {
  it('lists every code list with its keeper, what the requisition asks of it, and how many are in use', () => {
    render(<CodesSection setup={SETUP} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(CODE_LISTS.length);
    expect(rows[0]!.textContent).toBe('Item codesStock keeperRequired on every line2');
    expect(within(rows.find((row) => row.textContent?.startsWith('Request codes'))!).getByLabelText('Request codes: on the requisition').textContent).toBe('Optional');
    // As before Setup, not as the board drew it: purchaser codes stay with the code admin until the office moves them.
    expect(screen.getByLabelText('Purchaser codes (companies): who may make and change').textContent).toBe('Code admin');
  });

  it('saves a new keeper for one list and keeps the others as they are', () => {
    render(<CodesSection setup={SETUP} />);
    pick('Vendor numbers: who may make and change', 'Code admin');
    expect(saves.codes.mutate).toHaveBeenCalledWith({ keepers: { ...DEFAULT_CODE_KEEPERS, VENDORS: 'CODE_ADMIN' } });
  });

  it('makes a list required on the requisition through the same setting as the page, so the two never disagree', () => {
    render(<CodesSection setup={SETUP} />);
    pick('Department codes: on the requisition', 'Required on every line');
    expect(lastPage().fields.LINE_DEPARTMENT).toEqual({ shown: true, required: true });
    expect(lastPage().factBoxes).toEqual(DEFAULT_PAGE_LAYOUT.factBoxes);
  });
});

describe('The requisition page', () => {
  it('shows each field and FactBox as the office keeps them, Vendor Statistics off to start', () => {
    render(<PageSection page={DEFAULT_PAGE_LAYOUT} />);
    expect((screen.getByRole('switch', { name: 'Request Code: shown' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('switch', { name: 'Request Code: required' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
    const order = within(screen.getByRole('region', { name: 'FactBoxes, in this order' })).getAllByRole('row').slice(1).map((row) => (row as HTMLTableRowElement).cells[1]!.textContent);
    expect(order).toEqual(['Requisition Statistics', 'Attachments', 'Line Details', 'Item Availability', 'Vendor Statistics']);
    expect(screen.getByRole('switch', { name: 'Vendor Statistics: shown' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('button', { name: 'Line Details: who sees it' }).textContent).toBe('Everybody');
  });

  it('never keeps a hidden field required', () => {
    const page: RequisitionPageLayout = { ...DEFAULT_PAGE_LAYOUT, fields: { ...DEFAULT_PAGE_LAYOUT.fields, COST_CENTER: { shown: true, required: true } } };
    const { rerender } = render(<PageSection page={page} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Cost Center Code: shown' }));
    expect(lastPage().fields.COST_CENTER).toEqual({ shown: false, required: false });

    rerender(<PageSection page={lastPage()} />);
    expect((screen.getByRole('switch', { name: 'Cost Center Code: required' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves a FactBox with its arrows, and the first cannot go higher', () => {
    render(<PageSection page={DEFAULT_PAGE_LAYOUT} />);
    expect((screen.getByRole('button', { name: 'Move Requisition Statistics up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Vendor Statistics up' }));
    expect(lastPage().factBoxes.map((box) => box.key)).toEqual(['STATISTICS', 'ATTACHMENTS', 'LINE_DETAILS', 'VENDOR_STATISTICS', 'ITEM_AVAILABILITY']);
  });

  it('shows a FactBox to the roles ticked, and to everybody again', () => {
    render(<PageSection page={DEFAULT_PAGE_LAYOUT} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Vendor Statistics: shown' }));
    expect(lastPage().factBoxes.at(-1)).toEqual({ key: 'VENDOR_STATISTICS', shown: true, audience: [] });

    const trigger = screen.getByRole('button', { name: 'Item Availability: who sees it' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Purchaser' }));
    expect(lastPage().factBoxes[3]).toEqual({ key: 'ITEM_AVAILABILITY', shown: true, audience: ['PURCHASER'] });
  });
});
