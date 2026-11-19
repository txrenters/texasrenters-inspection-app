import type { PurchasingCodeRow, PurchasingCodes } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodesTab } from './codes-tab';

/** Purchasing codes (2026-11-20). Every company, code and tracking option invented. */

const hooks = vi.hoisted(() => ({ usePurchasingCodes: vi.fn(), usePurchasingCodeEdits: vi.fn() }));
vi.mock('@/lib/purchasing-codes-queries', () => hooks);

const code = (over: Partial<PurchasingCodeRow> = {}): PurchasingCodeRow => ({ id: 'type-item', kind: 'LINE_TYPE', code: 'ITEM', name: 'Item', keepsStock: true, active: true, xero: [], used: 12, ...over });
const DATA: PurchasingCodes = {
  codes: [
    code(),
    code({ id: 'type-service', code: 'SERVICE', name: 'Service', keepsStock: false, used: 1 }),
    code({ id: 'req-restock', kind: 'REQUEST', code: 'RESTOCK', name: 'Restock the storeroom', used: 0 }),
    code({ id: 'dept-maint', kind: 'DEPARTMENT', code: 'MAINT', name: 'Maintenance', used: 0, xero: [{ xeroTenantId: 'tenant-homes', trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-maint', label: 'Department: Maintenance' }] }),
  ],
  companies: [
    { xeroTenantId: 'tenant-homes', name: 'Example Home Services', purchaserCode: null, trackingCategories: [{ id: 'cat-dept', name: 'Department', options: [{ id: 'opt-maint', name: 'Maintenance' }, { id: 'opt-hvac', name: 'HVAC' }] }] },
    { xeroTenantId: 'tenant-pest', name: 'Example Pest', purchaserCode: 'PEST', trackingCategories: [] },
  ],
};

const mutation = () => ({ mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(async () => DATA), isPending: false, error: null as Error | null, reset: vi.fn() });
let edits: Record<'create' | 'update' | 'setPurchaserCode', ReturnType<typeof mutation>>;
const pick = (label: string, option: string | RegExp, root: HTMLElement = document.body) => {
  fireEvent.keyDown(within(root).getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};

beforeEach(() => {
  edits = { create: mutation(), update: mutation(), setPurchaserCode: mutation() };
  hooks.usePurchasingCodes.mockReturnValue({ isError: false, data: DATA });
  hooks.usePurchasingCodeEdits.mockReturnValue(edits);
});

describe('the lists', () => {
  it('shows the line types with whether each keeps stock and how many item codes are of it', () => {
    render(<CodesTab enabled />);
    const table = screen.getByRole('table', { name: 'Line types' });
    expect(within(table).getByRole('row', { name: /SERVICE/ }).textContent).toContain('No');
    expect(within(table).getByRole('row', { name: /ITEM/ }).textContent).toContain('12');
  });

  it('shows a department with its Xero tracking, one list at a time', () => {
    render(<CodesTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: /Department codes/ }));
    const table = screen.getByRole('table', { name: 'Department codes' });
    expect(within(table).getByRole('row', { name: /MAINT/ }).textContent).toContain('Department: Maintenance');
    expect(screen.queryByRole('table', { name: 'Line types' })).toBeNull();
  });
});

describe('a new code', () => {
  it('is sent in capitals on the list that is open', async () => {
    render(<CodesTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: /Request codes/ }));
    const form = screen.getByRole('form', { name: 'New request code' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'urgent' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: ' Urgent, this week ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add request code' }));
    await waitFor(() => expect(edits.create.mutateAsync).toHaveBeenCalledWith({ kind: 'REQUEST', code: 'URGENT', name: 'Urgent, this week' }));
    expect(await within(form).findByText('URGENT is added.')).toBeTruthy();
  });

  it('makes a line type that keeps no stock', async () => {
    render(<CodesTab enabled />);
    const form = screen.getByRole('form', { name: 'New line type' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'FEE' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Fee or charge' } });
    fireEvent.click(within(form).getByLabelText('Keeps stock'));
    fireEvent.click(within(form).getByRole('button', { name: 'Add line type' }));
    await waitFor(() => expect(edits.create.mutateAsync).toHaveBeenCalledWith({ kind: 'LINE_TYPE', code: 'FEE', name: 'Fee or charge', keepsStock: false }));
  });

  it('matches a department to a tracking option in a company\'s Xero', async () => {
    render(<CodesTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: /Department codes/ }));
    const form = screen.getByRole('form', { name: 'New department code' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'HVAC' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'HVAC' } });
    pick('Xero tracking in Example Home Services', 'Department: HVAC');
    fireEvent.click(within(form).getByRole('button', { name: 'Add department code' }));
    await waitFor(() =>
      expect(edits.create.mutateAsync).toHaveBeenCalledWith({ kind: 'DEPARTMENT', code: 'HVAC', name: 'HVAC', xero: [{ xeroTenantId: 'tenant-homes', trackingCategoryId: 'cat-dept', trackingOptionId: 'opt-hvac' }] }),
    );
  });

  it('says what is wrong with a code that will not do, and sends nothing', () => {
    render(<CodesTab enabled />);
    const form = screen.getByRole('form', { name: 'New line type' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'NOT/OK' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Bad' } });
    expect(within(form).getByText(/A code is 1 to 20 capitals/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Add line type' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('changing a code', () => {
  it('sends only what changed, and switches a code off rather than removing it', async () => {
    render(<CodesTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit SERVICE' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit SERVICE' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Service work' } });
    fireEvent.click(within(dialog).getByLabelText('In use'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edits.update.mutateAsync).toHaveBeenCalledWith({ codeId: 'type-service', input: { name: 'Service work', active: false } }));
  });

  it('takes a department\'s Xero match away when set to not matched', async () => {
    render(<CodesTab enabled />);
    fireEvent.click(screen.getByRole('button', { name: /Department codes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit MAINT' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit MAINT' });
    pick('Xero tracking in Example Home Services', 'Not matched', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edits.update.mutateAsync).toHaveBeenCalledWith({ codeId: 'dept-maint', input: { xero: [] } }));
  });
});

describe('purchaser codes', () => {
  it('gives a company its code in capitals, and takes one away', async () => {
    render(<CodesTab enabled />);
    const homes = screen.getByRole('form', { name: 'Purchaser code of Example Home Services' });
    fireEvent.change(within(homes).getByLabelText('Purchaser code'), { target: { value: 'thmp' } });
    fireEvent.click(within(homes).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(edits.setPurchaserCode.mutateAsync).toHaveBeenCalledWith({ xeroTenantId: 'tenant-homes', input: { purchaserCode: 'THMP' } }));

    const pest = screen.getByRole('form', { name: 'Purchaser code of Example Pest' });
    fireEvent.change(within(pest).getByLabelText('Purchaser code'), { target: { value: '' } });
    fireEvent.click(within(pest).getByRole('button', { name: 'Take away' }));
    await waitFor(() => expect(edits.setPurchaserCode.mutateAsync).toHaveBeenCalledWith({ xeroTenantId: 'tenant-pest', input: { purchaserCode: null } }));
  });

  it('shows the server\'s words when the code is another company\'s', async () => {
    edits.setPurchaserCode.mutateAsync.mockRejectedValueOnce(new Error('PEST is already another company\'s purchaser code.'));
    render(<CodesTab enabled />);
    const homes = screen.getByRole('form', { name: 'Purchaser code of Example Home Services' });
    fireEvent.change(within(homes).getByLabelText('Purchaser code'), { target: { value: 'PEST' } });
    fireEvent.click(within(homes).getByRole('button', { name: 'Save' }));
    expect(await within(homes).findByText("PEST is already another company's purchaser code.")).toBeTruthy();
  });
});
