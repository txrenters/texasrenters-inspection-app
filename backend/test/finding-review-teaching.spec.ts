import 'reflect-metadata';

import { UserRole } from '@texasrenters/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { FindingEditDto, FindingRejectDto, SaveAiGuidanceDto } from '../src/admin/admin.dto';
import { AdminService } from '../src/admin/admin.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { PresenceService } from '../src/realtime/presence.service';

/**
 * A reviewer's decision on an AI finding, as the AI later learns from it
 * (2026-10-03): a rejection says why from a fixed list, and a finding that was
 * nearly right is corrected and approved rather than rejected and rewritten.
 * People and ids invented.
 */

const user: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000003',
  authUserId: 'auth-reviewer',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Reviewer',
  roles: [UserRole.PROPERTY_ADMIN],
  permissions: ['findings:review'],
  mustChangePassword: false,
  principalType: 'USER',
};

const AI_WROTE = {
  title: 'Damaged wall near the door',
  description: 'A large scuff on the wall.',
  severity: 'HIGH',
  findingType: 'POSSIBLE_NEW_DAMAGE',
  category: 'Walls',
};

function build(finding: Record<string, unknown> | null, opts: { claimed?: number } = {}) {
  const tx = {
    inspectionFinding: {
      findFirst: jest.fn().mockResolvedValue(finding),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'finding-1',
        inspectionId: 'inspection-1',
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'finding-1',
        inspectionId: 'inspection-1',
        reviewStatus: 'APPROVED',
      }),
    },
    findingReview: { create: jest.fn().mockResolvedValue({ id: 'review-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
  };
  return { service: new AdminService(prisma as never, new PresenceService()), tx };
}

describe('rejecting a finding', () => {
  it('keeps the reason chosen from the list beside the decision, and in the audit', async () => {
    const { service, tx } = build({
      id: 'finding-1',
      inspectionId: 'inspection-1',
      reviewStatus: 'PENDING_REVIEW',
    });

    await service.reviewFinding(user, 'finding-1', 'REJECTED', undefined, 'NORMAL_WEAR');

    expect(tx.findingReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'REJECTED', reasonCode: 'NORMAL_WEAR' }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'FINDING_REJECTED',
        metadata: expect.objectContaining({ reasonCode: 'NORMAL_WEAR', reason: null }),
      }),
    });
  });

  it('never puts a reject reason on an approval', async () => {
    const { service, tx } = build({
      id: 'finding-1',
      inspectionId: 'inspection-1',
      reviewStatus: 'PENDING_REVIEW',
    });

    await service.reviewFinding(user, 'finding-1', 'APPROVED', undefined, 'NORMAL_WEAR');

    expect(tx.findingReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'APPROVED', reasonCode: null }),
    });
  });
});

describe('what a rejection must say', () => {
  const check = async (body: object) =>
    (await validate(plainToInstance(FindingRejectDto, body))).map((error) => error.property);

  it('a reason from the list is enough', async () => {
    expect(await check({ reasonCode: 'ALREADY_AT_MOVE_IN' })).toEqual([]);
    expect(await check({ reasonCode: 'NORMAL_WEAR', reason: '' })).toEqual([]);
  });

  it('without one, or with Other, the note is required', async () => {
    expect(await check({})).toEqual(['reason']);
    expect(await check({ reasonCode: 'OTHER' })).toEqual(['reason']);
    expect(await check({ reasonCode: 'OTHER', reason: 'Tenant repaired it already.' })).toEqual(
      [],
    );
    expect(await check({ reason: 'Not in this unit.' })).toEqual([]);
  });

  it('a note sent with a listed reason is still checked', async () => {
    expect(await check({ reasonCode: 'DUPLICATE', reason: 'x'.repeat(1001) })).toEqual(['reason']);
  });

  it('a reason not on the list is refused', async () => {
    expect(await check({ reasonCode: 'TENANT_FAULT' })).toEqual(['reasonCode']);
  });
});

describe('correcting a finding and approving it', () => {
  const pending = {
    id: 'finding-1',
    inspectionId: 'inspection-1',
    reviewStatus: 'PENDING_REVIEW',
    ...AI_WROTE,
    inspection: { finalizedAt: null },
  };
  const corrected = {
    title: 'Scuffed paint near the door',
    description: 'A large scuff on the wall.',
    severity: 'LOW' as const,
    findingType: 'MAINTENANCE' as const,
    category: 'Walls',
  };

  it('approves the corrected finding and keeps what the AI wrote beside it', async () => {
    const { service, tx } = build(pending);

    await service.editFinding(user, 'finding-1', { ...corrected, note: ' Paint, not drywall. ' });

    // Approved, so the report and the charges read it as any approved finding.
    expect(tx.inspectionFinding.updateMany).toHaveBeenCalledWith({
      where: { id: 'finding-1', reviewStatus: 'PENDING_REVIEW' },
      data: { ...corrected, reviewStatus: 'APPROVED' },
    });
    expect(tx.findingReview.create).toHaveBeenCalledWith({
      data: {
        findingId: 'finding-1',
        reviewerId: user.id,
        status: 'EDITED',
        reason: 'Paint, not drywall.',
        editedValue: {
          before: AI_WROTE,
          after: corrected,
          changed: ['title', 'severity', 'findingType'],
        },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'FINDING_EDITED',
        entityType: 'InspectionFinding',
        metadata: expect.objectContaining({
          inspectionId: 'inspection-1',
          changed: ['title', 'severity', 'findingType'],
        }),
      }),
    });
  });

  it('records an unchanged finding as a plain approval, which teaches nothing', async () => {
    const { service, tx } = build(pending);

    await service.editFinding(user, 'finding-1', AI_WROTE as never);

    expect(tx.findingReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'APPROVED', editedValue: undefined }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'FINDING_APPROVED' }),
    });
  });

  it('only corrects a finding still waiting for review', async () => {
    const { service, tx } = build({ ...pending, reviewStatus: 'REJECTED' });

    await expect(service.editFinding(user, 'finding-1', corrected)).rejects.toMatchObject({
      code: 'FINDING_ALREADY_DECIDED',
    });
    expect(tx.findingReview.create).not.toHaveBeenCalled();
  });

  it('loses to a reviewer who decided it a moment earlier', async () => {
    const { service, tx } = build(pending, { claimed: 0 });

    await expect(service.editFinding(user, 'finding-1', corrected)).rejects.toMatchObject({
      code: 'FINDING_ALREADY_DECIDED',
    });
    expect(tx.findingReview.create).not.toHaveBeenCalled();
  });

  it('leaves a finalized inspection’s findings as they were reported', async () => {
    const { service, tx } = build({ ...pending, inspection: { finalizedAt: new Date() } });

    await expect(service.editFinding(user, 'finding-1', corrected)).rejects.toMatchObject({
      code: 'INSPECTION_FINALIZED',
    });
    expect(tx.inspectionFinding.updateMany).not.toHaveBeenCalled();
  });

  it('is found only in the reviewer’s own organization', async () => {
    const { service, tx } = build(null);

    await expect(service.editFinding(user, 'finding-1', corrected)).rejects.toMatchObject({
      code: 'FINDING_NOT_FOUND',
    });
    expect(tx.inspectionFinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'finding-1', inspection: { organizationId: user.organizationId } },
      }),
    );
  });

  it('takes only the severities and types the AI itself may write', async () => {
    const errors = await validate(
      plainToInstance(FindingEditDto, { ...corrected, severity: 'CRITICAL', findingType: 'CHARGE' }),
    );
    expect(errors.map((error) => error.property).sort()).toEqual(['findingType', 'severity']);
  });
});

describe('the house rules payload', () => {
  it('may be empty, which switches the rules off and keeps the history', async () => {
    expect(await validate(plainToInstance(SaveAiGuidanceDto, { text: '' }))).toHaveLength(0);
  });

  it('is bounded as the database is', async () => {
    const errors = await validate(plainToInstance(SaveAiGuidanceDto, { text: 'x'.repeat(8001) }));
    expect(errors.map((error) => error.property)).toEqual(['text']);
  });
});
