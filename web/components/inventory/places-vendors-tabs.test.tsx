import type { StockPlaceRow, VendorRow } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlacesTab } from './places-tab';
import { VendorsTab } from './vendors-tab';

/** Places and Vendors, rebuilt to the approved drawing (2026-11-19). Every place, person and vendor invented. */

const hooks = vi.hoisted(() => ({ useStockPlaces: vi.fn(), useVendors: vi.fn(), useInventoryEdits: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);

const place = (over: Partial<StockPlaceRow> = {}): StockPlaceRow => ({ id: 'place-storeroom', name: 'Storeroom', code: 'STORE', kind: 'STOCKROOM', technicianId: null, technicianName: null, itemsHeld: 42, active: true, ...over });
const PLACES = [
  place(),
  place({ id: 'place-truck-1', name: 'Truck 1', kind: 'VAN', technicianId: 'tech-ana', technicianName: 'Ana Sample', itemsHeld: 11 }),
  place({ id: 'place-shared', name: 'Shared truck', kind: 'VAN', itemsHeld: 6 }),
  place({ id: 'place-shed', name: 'Old shed', itemsHeld: 0, active: false }),
];
const TECHNICIANS = [
  { id: 'tech-ana', name: 'Ana Sample' },
  { id: 'tech-ben', name: 'Ben Sample' },
];
const vendor = (over: Partial<VendorRow> = {}): VendorRow => ({ id: 'vendor-hill', number: 'V-00003', name: 'Hill Country Supply', contactName: 'A Person', email: 'orders@example.test', phone: '512-555-0100', terms: 'Net 30', notes: null, active: true, ...over });
const VENDORS = [vendor(), vendor({ id: 'vendor-pest', name: 'Lone Star Pest Supply', contactName: null, email: null, phone: '830-555-0177', terms: 'Net 15' }), vendor({ id: 'vendor-old', name: 'Old Filter Co', active: false })];

const mutation = () => ({ mutateAsync: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({})), isPending: false, error: null as Error | null, reset: vi.fn() });
let edits: Record<'createPlace' | 'updatePlace' | 'createVendor' | 'updateVendor', ReturnType<typeof mutation>>;
const pick = (root: HTMLElement, label: string | RegExp, option: string | RegExp) => {
  fireEvent.keyDown(within(root).getByLabelText(label), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const field = (root: HTMLElement, label: string | RegExp) => within(root).getByLabelText(label) as HTMLInputElement;

beforeEach(() => {
  edits = { createPlace: mutation(), updatePlace: mutation(), createVendor: mutation(), updateVendor: mutation() };
  hooks.useInventoryEdits.mockReturnValue(edits);
  hooks.useStockPlaces.mockReturnValue({ isError: false, data: { places: PLACES, technicians: TECHNICIANS } });
  hooks.useVendors.mockReturnValue({ isError: false, data: { vendors: VENDORS } });
});

describe('the Places tab', () => {
  it('lists each place with its kind in the office\'s words, who it is for and how many items it holds', () => {
    render(<PlacesTab canManage enabled />);
    const table = screen.getByRole('table', { name: 'Places stock is kept' });
    expect(within(table).getByRole('row', { name: /^Storeroom/ }).textContent).toContain('StoreroomNone42In use');
    const truck = within(table).getByRole('row', { name: /Truck 1/ });
    for (const words of ['Truck', 'Ana Sample', '11']) expect(truck.textContent).toContain(words);
    // Nobody named on it: any technician may use it.
    expect(within(table).getByRole('row', { name: /Shared truck/ }).textContent).toContain('Anybody');
    expect(within(table).getByRole('row', { name: /Old shed/ }).textContent).toContain('Switched off');
    expect(table.textContent).not.toMatch(/\bVan\b/);
    expect(screen.getByText('How stock gets to a truck')).toBeTruthy();
  });

  it('adds a truck for one technician, or for anybody', async () => {
    render(<PlacesTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New place' });
    const add = within(form).getByRole('button', { name: 'Add place' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(field(form, 'Name'), { target: { value: ' Truck 3 ' } });
    fireEvent.click(add);
    await waitFor(() => expect(edits.createPlace.mutateAsync).toHaveBeenCalledWith({ name: 'Truck 3', kind: 'VAN' }));
    expect(await within(form).findByText('Truck 3 is added.')).toBeTruthy();

    fireEvent.change(field(form, 'Name'), { target: { value: 'Truck 4' } });
    pick(form, /^Technician/, 'Ben Sample');
    fireEvent.click(add);
    await waitFor(() => expect(edits.createPlace.mutateAsync).toHaveBeenLastCalledWith({ name: 'Truck 4', kind: 'VAN', technicianId: 'tech-ben' }));
  });

  it('suggests a location code from the name, and sends one only when it is typed (2026-11-20)', async () => {
    render(<PlacesTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New place' });
    fireEvent.change(field(form, 'Name'), { target: { value: 'Truck 3' } });
    expect(within(form).getByText(/Left empty, it is TRUCK-3/)).toBeTruthy();
    expect((field(form, 'Location code') as HTMLInputElement).placeholder).toBe('TRUCK-3');
    fireEvent.change(field(form, 'Location code'), { target: { value: 'trk-03' } });
    expect((field(form, 'Location code') as HTMLInputElement).value).toBe('TRK-03');
    fireEvent.click(within(form).getByRole('button', { name: 'Add place' }));
    await waitFor(() => expect(edits.createPlace.mutateAsync).toHaveBeenCalledWith({ name: 'Truck 3', kind: 'VAN', code: 'TRK-03' }));

    fireEvent.change(field(form, 'Name'), { target: { value: 'Truck 4' } });
    fireEvent.change(field(form, 'Location code'), { target: { value: 'NOT/OK' } });
    expect(within(form).getByText(/A code is 1 to 20 capitals/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Add place' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows each place\'s location code', () => {
    render(<PlacesTab canManage enabled />);
    expect(within(screen.getByRole('table', { name: 'Places stock is kept' })).getByRole('row', { name: /^Storeroom/ }).textContent).toContain('STORE');
  });

  it('adds a storeroom with nobody on it', async () => {
    render(<PlacesTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New place' });
    fireEvent.change(field(form, 'Name'), { target: { value: 'Back room' } });
    pick(form, 'Kind', 'Storeroom');
    expect(within(form).queryByLabelText(/^Technician/)).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Add place' }));
    await waitFor(() => expect(edits.createPlace.mutateAsync).toHaveBeenCalledWith({ name: 'Back room', kind: 'STOCKROOM' }));
  });

  it('shows the server\'s words when a name is taken, and keeps what was typed', async () => {
    edits.createPlace.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    edits.createPlace.error = new Error('There is already a place called Truck 1.');
    render(<PlacesTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New place' });
    fireEvent.change(field(form, 'Name'), { target: { value: 'Truck 1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add place' }));
    await waitFor(() => expect(edits.createPlace.mutateAsync).toHaveBeenCalled());
    expect(within(form).getByText('There is already a place called Truck 1.')).toBeTruthy();
    expect(field(form, 'Name').value).toBe('Truck 1');
  });

  it('edits a place\'s name and technician, never its kind', async () => {
    render(<PlacesTab canManage enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Truck 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit place' });
    expect(within(dialog).queryByLabelText('Kind')).toBeNull();
    fireEvent.change(field(dialog, 'Name'), { target: { value: 'Truck One' } });
    pick(dialog, 'Technician', /Nobody: any technician may use it/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save place' }));
    await waitFor(() => expect(edits.updatePlace.mutateAsync).toHaveBeenCalledWith({ placeId: 'place-truck-1', input: { name: 'Truck One', technicianId: null } }));
  });

  it('has no form and no Edit for somebody who is not the stock keeper, and reads nothing until its tab is open', () => {
    render(<PlacesTab canManage={false} enabled={false} />);
    expect(hooks.useStockPlaces).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('form', { name: 'New place' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  });
});

describe('the Vendors tab', () => {
  it('shows each vendor\'s number, given by the console (2026-11-20)', () => {
    render(<VendorsTab canManage enabled />);
    expect(within(screen.getByRole('table', { name: 'Vendors' })).getByRole('row', { name: /Hill Country Supply/ }).textContent).toContain('V-00003');
  });

  it('lists each vendor, and narrows by name or contact', () => {
    render(<VendorsTab canManage enabled />);
    const table = screen.getByRole('table', { name: 'Vendors' });
    for (const words of ['A Person', 'orders@example.test', '512-555-0100', 'Net 30']) expect(within(table).getByRole('row', { name: /Hill Country Supply/ }).textContent).toContain(words);
    expect(within(table).getByRole('row', { name: /Lone Star Pest Supply/ }).textContent).toContain('No email');
    expect(within(table).getByRole('row', { name: /Old Filter Co/ }).textContent).toContain('Switched off');

    fireEvent.change(screen.getByLabelText('Search vendors'), { target: { value: 'lone' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search vendors'), { target: { value: 'nobody at all' } });
    expect(screen.getByText('No vendor matches the search.')).toBeTruthy();
  });

  it('adds a vendor with only a name, or with everything', async () => {
    render(<VendorsTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New vendor' });
    const add = within(form).getByRole('button', { name: 'Add vendor' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(field(form, 'Name'), { target: { value: ' Alamo Trade Parts ' } });
    fireEvent.click(add);
    await waitFor(() => expect(edits.createVendor.mutateAsync).toHaveBeenCalledWith({ name: 'Alamo Trade Parts' }));
    expect(await within(form).findByText('Alamo Trade Parts is added.')).toBeTruthy();

    fireEvent.change(field(form, 'Name'), { target: { value: 'Hill Country Supply' } });
    fireEvent.change(field(form, /^Contact person/), { target: { value: 'A Person' } });
    fireEvent.change(field(form, /^Email/), { target: { value: 'orders@example.test' } });
    fireEvent.change(field(form, /^Phone/), { target: { value: '512-555-0100' } });
    fireEvent.change(field(form, /^Terms/), { target: { value: 'Net 30' } });
    fireEvent.change(field(form, /^Notes/), { target: { value: 'Delivers Tuesdays' } });
    fireEvent.click(add);
    await waitFor(() =>
      expect(edits.createVendor.mutateAsync).toHaveBeenLastCalledWith({ name: 'Hill Country Supply', contactName: 'A Person', email: 'orders@example.test', phone: '512-555-0100', terms: 'Net 30', notes: 'Delivers Tuesdays' }),
    );
  });

  it('will not add a vendor whose email is not one', () => {
    render(<VendorsTab canManage enabled />);
    const form = screen.getByRole('form', { name: 'New vendor' });
    fireEvent.change(field(form, 'Name'), { target: { value: 'Alamo Trade Parts' } });
    fireEvent.change(field(form, /^Email/), { target: { value: 'not an email' } });
    expect(within(form).getByText('That email does not look right.')).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Add vendor' }) as HTMLButtonElement).disabled).toBe(true);
    expect(edits.createVendor.mutateAsync).not.toHaveBeenCalled();
  });

  it('edits a vendor in its dialog, and shows nothing to press to somebody who is not the stock keeper', async () => {
    const { unmount } = render(<VendorsTab canManage enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Hill Country Supply' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    unmount();

    render(<VendorsTab canManage={false} enabled />);
    expect(screen.queryByRole('form', { name: 'New vendor' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.getByText('Hill Country Supply')).toBeTruthy();
  });
});
