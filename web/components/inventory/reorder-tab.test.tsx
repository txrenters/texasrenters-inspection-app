import type { InventoryMonitoring, ReorderRow } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReorderTab } from './reorder-tab';

/** Reorder and usage, phase 7 (2026-11-19). Every item, person and figure invented. */

const hooks = vi.hoisted(() => ({ useInventoryMonitoring: vi.fn() }));
vi.mock('@/lib/inventory-queries', () => hooks);
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const row = (over: Partial<ReorderRow> = {}): ReorderRow => ({
  itemId: 'item-filter',
  code: 'FLT-0003',
  name: 'Filter 20x25x1',
  unit: 'each',
  company: { tenantId: 'tenant-homes', name: 'Example Home Services LLC' },
  status: 'OUT',
  onHand: 0,
  reorderLevel: 18,
  onOrder: 0,
  used: 30,
  lastsDays: 0,
  suggested: 36,
  usualVendor: { id: 'vendor-hill', name: 'Hill Country Supply' },
  ...over,
});
const battery = (over: Partial<ReorderRow> = {}) => row({ itemId: 'item-battery', code: 'PRT-0001', name: 'Battery, 9 V', status: 'LOW', onHand: 5, reorderLevel: 12, used: 13, lastsDays: 11, suggested: 24, usualVendor: null, ...over });
const flea = (over: Partial<ReorderRow> = {}) => row({ itemId: 'item-flea', code: 'PST-0002', name: 'Flea treatment, 1 qt', status: 'LOW', onHand: 2, reorderLevel: 4, onOrder: 6, used: 0, lastsDays: null, suggested: 6, company: { tenantId: 'tenant-pest', name: 'Example Pest Co' }, usualVendor: null, ...over });
const report = (over: Partial<InventoryMonitoring> = {}): InventoryMonitoring => ({
  period: '30d',
  from: '2026-10-21',
  to: '2026-11-19',
  usedCents: 41260,
  boughtCents: 74470,
  lostInCountsCents: 5510,
  reorder: [row(), battery(), flea()],
  byTechnician: [
    { technicianId: 'tech-ana', name: 'Ana Sample', valueCents: 16840, slips: 7 },
    { technicianId: 'tech-ben', name: 'Ben Sample', valueCents: 8420, slips: 3 },
  ],
  byJob: [
    { job: 'Hvac filter', visits: 58, valueCents: 24130 },
    { job: null, visits: 0, valueCents: 2150 },
  ],
  ...over,
});
const show = (data: InventoryMonitoring) => hooks.useInventoryMonitoring.mockReturnValue({ isError: false, data });
const mount = (over: { canRequest?: boolean; period?: string } = {}) => {
  const onPeriod = vi.fn();
  render(<ReorderTab canRequest={over.canRequest ?? true} onPeriod={onPeriod} period={over.period ?? '30d'} />);
  return onPeriod;
};
const make = () => screen.getByRole('button', { name: 'Make a purchase request from the ticked items' }) as HTMLButtonElement;

beforeEach(() => {
  router.push.mockReset();
  hooks.useInventoryMonitoring.mockReset();
  show(report());
});

describe('the figures', () => {
  it('says what is to reorder and what the materials came to over the period', () => {
    mount();
    const figure = (label: string) => screen.getByText(label).closest('div')?.parentElement?.textContent ?? '';
    expect(figure('To reorder now')).toContain('3 items');
    expect(figure('Materials used, last 30 days')).toContain('$412.60');
    expect(figure('Bought, last 30 days')).toContain('$744.70');
    expect(figure('Lost in counts, last 30 days')).toContain('$55.10');
    expect(screen.getByText('Wed, Oct 21 to Thu, Nov 19')).toBeTruthy();
    expect(hooks.useInventoryMonitoring).toHaveBeenCalledWith(true, '30d');
  });

  it('says "found" when the counts turned up more than they missed', () => {
    show(report({ lostInCountsCents: -910 }));
    mount();
    expect(screen.getByText('Found in counts, last 30 days').closest('div')?.parentElement?.textContent).toContain('$9.10');
  });

  it('reads another period when asked, and takes 30 days for one it does not know', () => {
    const onPeriod = mount({ period: 'decade' });
    expect(hooks.useInventoryMonitoring).toHaveBeenCalledWith(true, '30d');
    fireEvent.keyDown(screen.getByLabelText('Period'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'This quarter' }));
    expect(onPeriod).toHaveBeenCalledWith('quarter');
  });
});

describe('what to reorder', () => {
  it('lists each item with what is on hand, on order, how long it lasts and what to ask for', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Items to reorder' });
    const filter = within(table).getByRole('row', { name: /Filter 20x25x1/ });
    for (const words of ['Out', 'FLT-0003', 'Example Home Services LLC', '18', '0 days', 'Hill Country Supply']) expect(filter.textContent).toContain(words);
    expect((within(filter).getByLabelText('Quantity of Filter 20x25x1') as HTMLInputElement).value).toBe('36');
    expect(within(table).getByRole('row', { name: /Battery, 9 V/ }).textContent).toContain('11 days');
    // On order already: not ticked, and no quantity asked for.
    const ordered = within(table).getByRole('row', { name: /Flea treatment/ });
    expect(ordered.textContent).toContain('Already on order');
    expect(within(ordered).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    expect(within(table).getByRole('link', { name: 'Filter 20x25x1' }).getAttribute('href')).toBe('/inventory/items/item-filter');
  });

  it('opens a new purchase request with the ticked items and the quantities typed', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Quantity of Battery, 9 V'), { target: { value: '48' } });
    fireEvent.click(make());
    expect(router.push).toHaveBeenCalledWith('/purchasing/requisitions/new?items=item-filter:36,item-battery:48');
  });

  it('says why a request cannot be made: nothing ticked, no quantity, or two companies', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Quantity of Battery, 9 V'), { target: { value: '' } });
    expect(make().disabled).toBe(true);
    expect(screen.getByText(/Give each ticked item a whole number to ask for\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Quantity of Battery, 9 V'), { target: { value: '24' } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Include Flea treatment, 1 qt' }));
    expect(make().disabled).toBe(true);
    expect(screen.getByText(/The ticked items are for more than one company\./)).toBeTruthy();

    for (const name of ['Include Flea treatment, 1 qt', 'Include Filter 20x25x1', 'Include Battery, 9 V']) fireEvent.click(screen.getByRole('checkbox', { name }));
    expect(screen.getByText(/Tick the items to ask for\./)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows the list without ticks or a button to somebody who may not ask for a purchase', () => {
    mount({ canRequest: false });
    expect(screen.queryByRole('button', { name: /Make a purchase request/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Items to reorder' })).getByRole('row', { name: /Filter 20x25x1/ }).textContent).toContain('36');
  });

  it('says so when nothing has reached its reorder level', () => {
    show(report({ reorder: [] }));
    mount();
    expect(screen.getByText('Nothing to reorder')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Make a purchase request/ })).toBeNull();
  });
});

describe('what was used', () => {
  it('ranks the technicians, each opening their withdrawals', () => {
    mount();
    const section = screen.getByRole('heading', { name: 'Materials used, by technician' }).closest('section')!;
    expect(within(section).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Ana Sample$168.40', 'Ben Sample$84.20']);
    expect(within(section).getByRole('link', { name: 'Ana Sample' }).getAttribute('href')).toBe('/inventory?tab=withdrawals&technician=tech-ana');
  });

  it('gives each kind of job its visits, materials and cost a visit, and what no visit was named for', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Materials used, by kind of job' });
    expect(within(table).getByRole('row', { name: /Hvac filter/ }).textContent).toBe('Hvac filter58$241.30$4.16');
    expect(within(table).getByRole('row', { name: /No visit named/ }).textContent).toBe('No visit named$21.50');
  });

  it('says so when nothing was used', () => {
    show(report({ byTechnician: [], byJob: [] }));
    mount();
    expect(screen.getByText('Nobody took anything out in this period.')).toBeTruthy();
    expect(screen.getByText('No materials were used in this period.')).toBeTruthy();
  });
});
