import { PURCHASING_ROLES, type PurchasingPeople, type PurchasingPersonRow, type PurchasingRoleHold, type PurchasingRoleKey } from '@texasrenters/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RolesSection } from './setup-roles';

/**
 * Purchasing Setup's roles and who holds them (2026-11-21, part 5b). Every
 * name, code and figure invented.
 */

const hooks = vi.hoisted(() => ({ usePurchasingPeople: vi.fn(), usePurchasingPeopleEdits: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const none = Object.fromEntries(PURCHASING_ROLES.map((role) => [role.key, null])) as Record<PurchasingRoleKey, PurchasingRoleHold>;
const person = (over: Partial<PurchasingPersonRow>): PurchasingPersonRow => ({
  id: 'p',
  name: 'Sample',
  code: 'SAMPLE',
  roles: none,
  systemAdmin: false,
  you: false,
  companyTenantIds: [],
  approvesAnyAmount: false,
  approvalLimitCents: null,
  ...over,
});
const PEOPLE: PurchasingPeople = {
  people: [
    person({ id: 'pat', name: 'Pat Sample', code: 'PSAMPLE', roles: { ...none, REQUISITIONER: 'ROLE', PURCHASER: 'ROLE' }, companyTenantIds: ['thmp', 'ccp'] }),
    person({ id: 'lee', name: 'Lee Sample', code: 'LSAMPLE', roles: { ...none, APPROVER: 'ROLE' }, approvalLimitCents: 500000, companyTenantIds: ['thmp'] }),
    person({ id: 'ann', name: 'Ann Sample', code: 'ASAMPLE', roles: { ...none, APPROVER: 'OTHER' } }),
    person({ id: 'me', name: 'Sample Admin', code: 'SADMIN', roles: { ...none, PURCHASING_ADMIN: 'ROLE' }, you: true }),
  ],
  roles: PURCHASING_ROLES.map((role) => ({ key: role.key, label: role.label, roleId: null, roleName: null, permissions: [...role.permissions], grantable: role.key !== 'PURCHASING_ADMIN' })),
  companies: [
    { tenantId: 'ccp', name: 'Crystal Creek Pest', purchaserCode: 'CCP' },
    { tenantId: 'thmp', name: 'Texas Home Maintenance Pros', purchaserCode: 'THMP' },
  ],
  candidates: [{ id: 'sam', name: 'Sam Stock' }],
};
let edits: Record<'setRole' | 'savePerson' | 'addPerson', { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null }>;

beforeEach(() => {
  edits = { setRole: { mutate: vi.fn(), isPending: false, error: null }, savePerson: { mutate: vi.fn(), isPending: false, error: null }, addPerson: { mutate: vi.fn(), isPending: false, error: null } };
  hooks.usePurchasingPeopleEdits.mockReturnValue(edits);
  hooks.usePurchasingPeople.mockReturnValue({ isLoading: false, isError: false, data: PEOPLE });
});

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLButtonElement;

describe('Roles and who holds them', () => {
  it('shows each person, their roles, an approver limit and their companies, as the board does', () => {
    render(<RolesSection enabled />);
    const rows = screen.getAllByRole('row').map((row) => row.textContent);
    expect(rows[0]).toBe('PersonRequisitionerPurchaserApproverStock keeperReceiverCode adminBill payerPurchasing adminCompanies');
    expect(rows[1]).toContain('Pat Sample PSAMPLE');
    expect(rows[1]).toContain('THMP, CCP');
    expect(rows[2]).toContain('to $5,000.00');
    expect(box('Pat Sample: Purchaser').getAttribute('data-state')).toBe('checked');
    expect(box('Pat Sample: Approver').getAttribute('data-state')).toBe('unchecked');
    expect(screen.getByRole('link', { name: 'Open the Roles page' }).getAttribute('href')).toBe('/roles');
  });

  it('gives and takes a role when its box is ticked', () => {
    render(<RolesSection enabled />);
    fireEvent.click(box('Pat Sample: Approver'));
    expect(edits.setRole.mutate).toHaveBeenLastCalledWith({ personId: 'pat', role: 'APPROVER', held: true });
    fireEvent.click(box('Pat Sample: Purchaser'));
    expect(edits.setRole.mutate).toHaveBeenLastCalledWith({ personId: 'pat', role: 'PURCHASER', held: false });
  });

  it('locks what is not changed here: a role held through another, Purchasing admin, and your own row', () => {
    render(<RolesSection enabled />);
    expect(box('Ann Sample: Approver').disabled).toBe(true);
    expect(box('Ann Sample: Approver').title).toBe('Held through another role: changed on the Users page.');
    expect(box('Pat Sample: Purchasing admin').title).toBe('Only a system admin makes somebody a Purchasing admin.');
    expect(box('Sample Admin: Purchaser').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Sample Admin: companies' })).toBeNull();
  });

  it("changes an approver's limit and a person's companies", () => {
    render(<RolesSection enabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Lee Sample: approval limit' }));
    fireEvent.click(screen.getByLabelText('Any amount'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(edits.savePerson.mutate).toHaveBeenLastCalledWith({ personId: 'lee', input: { companyTenantIds: ['thmp'], approvesAnyAmount: true, approvalLimitCents: null } });

    fireEvent.click(screen.getByRole('button', { name: 'Lee Sample: approval limit' }));
    fireEvent.click(screen.getByLabelText('Up to an amount'));
    fireEvent.change(screen.getByLabelText('Approval limit, in dollars'), { target: { value: '7,500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save, up to $7,500.00' }));
    expect(edits.savePerson.mutate).toHaveBeenLastCalledWith({ personId: 'lee', input: { companyTenantIds: ['thmp'], approvesAnyAmount: false, approvalLimitCents: 750000 } });

    fireEvent.keyDown(screen.getByRole('button', { name: 'Pat Sample: companies' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Crystal Creek Pest/ }));
    expect(edits.savePerson.mutate).toHaveBeenLastCalledWith({ personId: 'pat', input: { companyTenantIds: ['thmp'], approvesAnyAmount: false, approvalLimitCents: null } });
  });

  it('adds somebody of the office to the list', () => {
    render(<RolesSection enabled />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Add a person' }), { key: 'Enter' });
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Sam Stock' }));
    expect(edits.addPerson.mutate).toHaveBeenCalledWith({ userProfileId: 'sam' });
  });
});
