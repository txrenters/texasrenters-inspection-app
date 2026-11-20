import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  DEFAULT_FILE_RULES,
  MACHINE_FORBIDDEN_PERMISSIONS,
  stepsFromLimit,
  type ApprovalStep,
  type SaveDocumentSeriesInput,
  type SavePurchasingApprovalsInput,
  type SaveRequisitionFileRulesInput,
} from '@texasrenters/shared';

import { PurchasingSetupController, SaveDocumentSeriesDto, SavePurchasingApprovalsDto, SaveRequisitionFileRulesDto } from '../src/admin/purchasing-setup.controller';
import { PurchasingSetupService } from '../src/admin/purchasing-setup.service';
import { nextDocumentCode } from '../src/admin/purchasing-settings';
import { RequisitionApproversService } from '../src/admin/requisition-approvers';
import { RequisitionRemindersScheduler } from '../src/admin/requisition-reminders.scheduler';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Purchasing Setup, part 5a (2026-11-20): the approval steps, the switches,
 * the file rules and the document numbers, each saved on its own and audited;
 * and the approvers asked by email and reminded once. Every name, address and
 * figure invented.
 */

const ORG = '80000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, name: string, permissions: string[]): AuthenticatedUser =>
  ({ id: id(n), authUserId: `auth-${n}`, organizationId: ORG, displayName: name, roles: [UserRole.PROPERTY_ADMIN], permissions, mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const admin = person(1, 'Sample Admin', ['purchasing:setup']);

const STEPS: ApprovalStep[] = [
  { upToCents: 50000, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: 1 },
  { upToCents: 500000, approver: 'ANY_APPROVER', quotesNeeded: 1, reminderDays: 1 },
  { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 2, reminderDays: 2 },
];

type Row = Record<string, unknown>;

function database() {
  const settings: Row[] = [];
  const steps: Row[] = [];
  const series: Row[] = [];
  const audits: Row[] = [];
  const db = {
    purchasingSettings: {
      findUnique: jest.fn(async () => settings[0] ?? null),
      upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => {
        if (settings[0]) Object.assign(settings[0], update);
        else
          settings.push({ approvalLimitCents: 50000, quotesAboveLimit: 2, emailApprovers: false, reapproveChangedOrders: false, fileGroups: ['PDF', 'PICTURES', 'WORD', 'EXCEL'], fileMaxBytes: 20_000_000, filesMax: 20, quoteFileAboveCents: null, fileRemoval: 'UNTIL_SENT', ...create });
      }),
    },
    purchasingApprovalStep: {
      findMany: jest.fn(async () => [...steps].sort((a, b) => (a.position as number) - (b.position as number))),
      deleteMany: jest.fn(async () => steps.splice(0, steps.length)),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => steps.push(...data)),
    },
    documentSeries: {
      findMany: jest.fn(async () => series),
      upsert: jest.fn(async ({ where, create, update }: { where: { organizationId_kind: { kind: string } }; create: Row; update: Row }) => {
        const found = series.find((row) => row.kind === where.organizationId_kind.kind);
        if (found) Object.assign(found, update);
        else series.push({ ...create });
      }),
    },
    // The series row under its lock.
    $queryRaw: jest.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => series.filter((row) => row.kind === values[1])),
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  const client: unknown = Object.assign(db, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(client)) });
  return { db, settings, steps, series, audits, service: new PurchasingSetupService(client as never) };
}

const approvals = (over: Partial<SavePurchasingApprovalsInput> = {}): SavePurchasingApprovalsInput => ({ steps: STEPS, emailApprovers: true, reapproveChangedOrders: false, ...over });

describe('Purchasing Setup', () => {
  it('starts as the office was: its limit as two steps, every kind of file, and each number as the console wrote it', async () => {
    const { service } = database();
    const setup = await service.read(admin);
    expect(setup.approvals).toEqual({ steps: stepsFromLimit(50000, 2), emailApprovers: false, reapproveChangedOrders: false });
    expect(setup.files).toEqual(DEFAULT_FILE_RULES);
    expect(setup.numbers.map((one) => `${one.label}: ${one.prefix}${'0'.repeat(one.digits - 1)}${one.next}`)).toEqual([
      'Purchase requisition: PR-00001',
      'Purchase order: PO-0001',
      'Receipt: RCV-0001',
      'Withdrawal: WD-0001',
      'Return: RT-0001',
      'Transfer: TR-0001',
      'Count: CNT-0001',
      'Vendor: V-00001',
    ]);
  });

  it('keeps the steps and switches, audits what they were and became, and writes nothing when nothing changed', async () => {
    const { service, steps, audits } = database();
    const saved = await service.saveApprovals(admin, approvals());
    expect(saved.approvals).toEqual(approvals());
    expect(steps.map((step) => [step.position, step.upToCents])).toEqual([
      [0, 50000],
      [1, 500000],
      [2, null],
    ]);
    expect(audits).toEqual([
      expect.objectContaining({ action: 'PURCHASING_SETUP_CHANGED', actorUserId: admin.id, metadata: { section: 'approvals', from: expect.objectContaining({ emailApprovers: false }), to: expect.objectContaining({ emailApprovers: true }) } }),
    ]);

    await service.saveApprovals(admin, approvals());
    expect(audits).toHaveLength(1);
  });

  it('refuses steps that do not climb, end without a top, or ask fewer people to approve more', async () => {
    const { service, audits } = database();
    await expect(service.saveApprovals(admin, approvals({ steps: STEPS.slice(0, 2) }))).rejects.toMatchObject({ code: 'PURCHASING_STEPS_INVALID' });
    await expect(service.saveApprovals(admin, approvals({ steps: [{ ...STEPS[0]!, approver: 'ANY_AMOUNT' }, STEPS[1]!, STEPS[2]!] }))).rejects.toMatchObject({ code: 'PURCHASING_STEPS_INVALID' });
    expect(audits).toEqual([]);
  });

  it('keeps the file rules as the board offers them, in its order', async () => {
    const { service, settings, audits } = database();
    const saved = await service.saveFiles(admin, { ...DEFAULT_FILE_RULES, groups: ['EXCEL', 'PDF'], maxBytes: 10_000_000, maxFiles: 8, quoteFileAboveCents: 50000, removal: 'UNTIL_ORDERED' });
    expect(saved.files).toEqual({ groups: ['PDF', 'EXCEL'], maxBytes: 10_000_000, maxFiles: 8, quoteFileAboveCents: 50000, removal: 'UNTIL_ORDERED' });
    expect(settings[0]).toMatchObject({ fileGroups: ['PDF', 'EXCEL'], fileMaxBytes: 10_000_000, filesMax: 8 });
    expect(audits).toHaveLength(1);
    await expect(service.saveFiles(admin, { ...DEFAULT_FILE_RULES, maxBytes: 25_000_000 })).rejects.toMatchObject({ code: 'PURCHASING_FILE_RULES_INVALID' });
  });

  it('moves a next number only up, under the series lock, and writes the numbers that follow with the new prefix', async () => {
    const { service, series, audits } = database();
    series.push({ kind: 'PR', next: 43, prefix: null, digits: null });
    await expect(service.saveSeries(admin, 'PR', { prefix: 'PR-', digits: 5, next: 40 })).rejects.toMatchObject({ code: 'PURCHASING_SERIES_INVALID', message: 'A next number can only go up: it is 43 now.' });

    const saved = await service.saveSeries(admin, 'PR', { prefix: 'REQ-', digits: 6, next: 50 });
    expect(saved.numbers[0]).toEqual({ kind: 'PR', label: 'Purchase requisition', prefix: 'REQ-', digits: 6, next: 50 });
    expect(audits).toEqual([expect.objectContaining({ metadata: { section: 'numbers:PR', from: { prefix: 'PR-', digits: 5, next: 43 }, to: { prefix: 'REQ-', digits: 6, next: 50 } } })]);

    const taking = { $queryRaw: jest.fn(async () => [{ taken: 50, prefix: 'REQ-', digits: 6 }]) };
    expect(await nextDocumentCode(taking as never, ORG, 'PR')).toBe('REQ-000050');
    // A series never set writes as before.
    const untouched = { $queryRaw: jest.fn(async () => [{ taken: 9, prefix: null, digits: null }]) };
    expect(await nextDocumentCode(untouched as never, ORG, 'PO')).toBe('PO-0009');
  });
});

describe('Purchasing Setup\'s contracts and permissions', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown, metatype: new () => object) => pipe.transform(value, { type: 'body', metatype });

  it('name every field, and refuse one they do not know', async () => {
    const files: Required<SaveRequisitionFileRulesInput> = { ...DEFAULT_FILE_RULES };
    const numbers: Required<SaveDocumentSeriesInput> = { prefix: 'PR-', digits: 5, next: 43 };
    await expect(check(approvals(), SavePurchasingApprovalsDto)).resolves.toBeDefined();
    await expect(check(files, SaveRequisitionFileRulesDto)).resolves.toBeDefined();
    await expect(check(numbers, SaveDocumentSeriesDto)).resolves.toBeDefined();
    await expect(check({ ...approvals(), approvalLimitCents: 50000 }, SavePurchasingApprovalsDto)).rejects.toBeDefined();
    await expect(check(approvals({ steps: [{ ...STEPS[2]!, approver: 'BOSS' as never }] }), SavePurchasingApprovalsDto)).rejects.toBeDefined();
    await expect(check({ ...files, groups: ['ZIP'] }, SaveRequisitionFileRulesDto)).rejects.toBeDefined();
  });

  it('are read and changed only by a Purchasing admin, which no API key may be', () => {
    for (const route of ['read', 'saveApprovals', 'saveFiles', 'saveSeries'])
      expect(Reflect.getMetadata('permissions', (PurchasingSetupController.prototype as unknown as Record<string, object>)[route]!)).toEqual(['purchasing:setup']);
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('purchasing:setup');
  });
});

describe('asking and reminding the approvers', () => {
  const member = (n: number, name: string, permissions: string[], over: Row = {}) => ({
    role: 'PROPERTY_ADMIN',
    userProfile: { id: id(n), email: `person${n}@example.test`, displayName: name, isActive: true, roleAssignments: [{ role: { permissions } }], ...over },
  });
  const MEMBERS = [
    member(10, 'Sample Requester', ['purchasing:request', 'purchasing:approve']),
    member(11, 'Sample Manager', ['purchasing:request', 'purchasing:approve']),
    member(12, 'Sample Owner', ['purchasing:request', 'purchasing:approve', 'purchasing:approve-any']),
    member(13, 'Sample Gone', ['purchasing:request', 'purchasing:approve'], { isActive: false }),
    member(14, 'Sample Buyer', ['purchasing:request', 'purchasing:order']),
  ];

  function office(saved: { emailApprovers: boolean; reminderDays: number | null }, requisition: Row) {
    const sent: { to: string; subject: string }[] = [];
    const requisitions = [requisition];
    const prisma = {
      organizationMember: { findMany: jest.fn(async () => MEMBERS) },
      purchasingSettings: { findUnique: jest.fn(async () => ({ approvalLimitCents: 50000, quotesAboveLimit: 0, emailApprovers: saved.emailApprovers, reapproveChangedOrders: false, fileGroups: ['PDF'], fileMaxBytes: 20_000_000, filesMax: 20, quoteFileAboveCents: null, fileRemoval: 'UNTIL_SENT' })) },
      purchasingApprovalStep: { findMany: jest.fn(async () => [{ upToCents: 50000, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: saved.reminderDays }, { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 0, reminderDays: saved.reminderDays }]) },
      purchaseRequisition: {
        findFirst: jest.fn(async () => requisitions[0]),
        findMany: jest.fn(async () => requisitions.filter((one) => !one.approvalRemindedAt)),
        updateMany: jest.fn(async ({ data }: { data: Row }) => {
          if (requisitions[0]!.approvalRemindedAt) return { count: 0 };
          Object.assign(requisitions[0]!, data);
          return { count: 1 };
        }),
      },
      xeroOrganisation: { findFirst: jest.fn(async () => ({ name: 'THMP' })) },
    };
    const mail = { sendRequisitionApproval: jest.fn(async (input: { to: string; subject: string }) => (sent.push(input), { status: 'SENT' })) };
    return { sent, requisitions, approvers: new RequisitionApproversService(prisma as never, mail as never) };
  }
  const requisition = (totalCents: number, requestedAt: Date): Row => ({
    id: id(90),
    number: 'PR-00043',
    requestedById: id(10),
    requestedBy: { displayName: 'Sample Requester' },
    xeroTenantId: 'tenant-thmp',
    lines: [{ quantity: 1, estimatedUnitCostCents: totalCents }],
    approvalRequestedAt: requestedAt,
    approvalRemindedAt: null,
  });

  it('emails the active people who may approve its step -- never whoever asked -- only when the office says so', async () => {
    const off = office({ emailApprovers: false, reminderDays: null }, requisition(18480, new Date()));
    expect(await off.approvers.ask(ORG, id(90))).toBe(0);
    expect(off.sent).toEqual([]);

    const on = office({ emailApprovers: true, reminderDays: null }, requisition(18480, new Date()));
    expect(await on.approvers.ask(ORG, id(90))).toBe(2);
    expect(on.sent.map((one) => [one.to, one.subject])).toEqual([
      ['person11@example.test', 'PR-00043 is waiting for your approval'],
      ['person12@example.test', 'PR-00043 is waiting for your approval'],
    ]);

    // Above the first step, only somebody who may approve any amount.
    const large = office({ emailApprovers: true, reminderDays: null }, requisition(61200, new Date()));
    await large.approvers.ask(ORG, id(90));
    expect(large.sent.map((one) => one.to)).toEqual(['person12@example.test']);
  });

  it('reminds once, after the step\'s days, and never again', async () => {
    const now = new Date('2026-11-21T15:00:00.000Z');
    const early = office({ emailApprovers: false, reminderDays: 1 }, requisition(18480, new Date('2026-11-21T09:00:00.000Z')));
    expect(await early.approvers.remind(ORG, now)).toBe(0);

    const due = office({ emailApprovers: false, reminderDays: 1 }, requisition(18480, new Date('2026-11-20T09:00:00.000Z')));
    expect(await due.approvers.remind(ORG, now)).toBe(1);
    expect(due.sent.map((one) => one.subject)).toEqual(['Reminder: PR-00043 is still waiting for your approval', 'Reminder: PR-00043 is still waiting for your approval']);
    expect(due.requisitions[0]).toMatchObject({ approvalRemindedAt: now });
    expect(await due.approvers.remind(ORG, now)).toBe(0);
    expect(due.sent).toHaveLength(2);

    const never = office({ emailApprovers: true, reminderDays: null }, requisition(18480, new Date('2026-11-01T09:00:00.000Z')));
    expect(await never.approvers.remind(ORG, now)).toBe(0);
  });

  it('runs only for offices with a step that reminds, and one office failing never stops another', async () => {
    const prisma = { purchasingApprovalStep: { findMany: jest.fn(async () => [{ organizationId: 'office-a' }, { organizationId: 'office-b' }]) } };
    const approvers = { remind: jest.fn(async (organizationId: string) => (organizationId === 'office-a' ? Promise.reject(new Error('down')) : 1)) };
    await new RequisitionRemindersScheduler(prisma as never, approvers as never).tick(new Date('2026-11-21T15:00:00.000Z'));
    expect(prisma.purchasingApprovalStep.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reminderDays: { not: null } } }));
    expect(approvers.remind.mock.calls.map(([organizationId]) => organizationId)).toEqual(['office-a', 'office-b']);
  });
});
