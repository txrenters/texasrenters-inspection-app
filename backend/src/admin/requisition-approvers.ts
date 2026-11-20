import { Inject, Injectable, Logger } from '@nestjs/common';
import { PurchaseRequisitionStatus as Status } from '@prisma/client';
import {
  approvalRefusal,
  approvalStepFor,
  formatMoney,
  requisitionTotalCents,
  resolveEffectivePermissions,
  type ApprovalStep,
  type PermissionKey,
} from '@texasrenters/shared';

import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import { escapeHtml } from './invoice-email';
import { readPurchasingSetup, standingOf } from './purchasing-settings';

/**
 * The approvers of a requisition, asked by email (Purchasing Setup,
 * 2026-11-20): once when it is sent for approval, if the office switched that
 * on, and reminded once if it is still waiting after its step's days.
 *
 * Billed calls: one email a person who may approve it, at most
 * MOST_APPROVERS_EMAILED, each time it is sent and once more for the
 * reminder. Nothing repeats on its own: a reminder is claimed before it is
 * sent, so a second run never sends it again.
 */

/** Enough for any office's approvers; a list longer than this is a role given too widely. */
export const MOST_APPROVERS_EMAILED = 10;
/** Requisitions reminded in one run for one office: the rest wait for the next hour. */
const MOST_REMINDERS_A_RUN = 50;
const DAY_MS = 86_400_000;

/** What an approver must hold to press Approve at all: the route asks for requesting and approving. */
export const PERMISSIONS_TO_APPROVE: PermissionKey[] = ['purchasing:request', 'purchasing:approve'];

/** The requisition an approver is asked about, and what approving it is held to. */
export interface ApprovalAsked {
  requesterId: string;
  steps: readonly ApprovalStep[];
  totalCents: number;
  companyTenantId: string | null;
  ownCompaniesOnly: boolean;
}

/** The console's address for a link, when the deployment says it. */
function consoleOrigin(): string | null {
  const configured = process.env.WEB_APP_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:' ? configured.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

@Injectable()
export class RequisitionApproversService {
  private readonly logger = new Logger(RequisitionApproversService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /**
   * The active people of the office who may approve this requisition, never
   * the one who asked: by the same rule the Approve button follows -- its step,
   * their own limit, and their companies when the office says so (Purchasing
   * Setup, 2026-11-21).
   */
  async approvers(organizationId: string, asked: ApprovalAsked): Promise<{ id: string; email: string; name: string }[]> {
    const requesterId = asked.requesterId;
    const [members, rows] = await Promise.all([
      this.prisma.organizationMember.findMany({
        where: { organizationId },
        select: {
          role: true,
          userProfile: {
            select: { id: true, email: true, displayName: true, isActive: true, roleAssignments: { where: { organizationId }, select: { role: { select: { permissions: true } } } } },
          },
        },
      }),
      this.prisma.purchasingPerson.findMany({ where: { organizationId }, select: { userProfileId: true, companyTenantIds: true, approvesAnyAmount: true, approvalLimitCents: true } }),
    ]);
    const settingsOf = new Map(rows.map((row) => [row.userProfileId, row]));
    const people = new Map<string, { id: string; email: string; name: string; roles: string[]; permissions: string[] }>();
    for (const { role, userProfile: person } of members) {
      if (!person.isActive || person.id === requesterId) continue;
      const seen = people.get(person.id) ?? { id: person.id, email: person.email, name: person.displayName, roles: [], permissions: person.roleAssignments.flatMap((one) => one.role.permissions) };
      seen.roles.push(role);
      people.set(person.id, seen);
    }
    return [...people.values()]
      .filter((person) => {
        const held = resolveEffectivePermissions(person.roles, person.permissions);
        if (!PERMISSIONS_TO_APPROVE.every((permission) => held.includes(permission))) return false;
        const standing = standingOf(held, settingsOf.get(person.id) ?? null);
        return approvalRefusal(standing, asked.steps, asked.totalCents, asked.companyTenantId, asked.ownCompaniesOnly) === null;
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MOST_APPROVERS_EMAILED)
      .map(({ id, email, name }) => ({ id, email, name }));
  }

  /**
   * Emails the approvers of a requisition just sent for approval, when the
   * office switched it on. Never throws: the requisition is sent whether the
   * email goes or not, and a failure is logged without any address.
   */
  async ask(organizationId: string, requisitionId: string): Promise<number> {
    try {
      const { approvals } = await readPurchasingSetup(this.prisma, organizationId);
      if (!approvals.emailApprovers) return 0;
      return await this.email(organizationId, requisitionId, false);
    } catch (error) {
      this.logger.warn({ event: 'requisition_approvers_not_asked', organizationId, message: error instanceof Error ? error.message : String(error) });
      return 0;
    }
  }

  /**
   * Reminds the approvers of every requisition that has waited past its
   * step's days, once each. Each is claimed before its email goes, so two
   * runs never remind twice. Returns how many were reminded.
   */
  async remind(organizationId: string, now = new Date()): Promise<number> {
    const { approvals } = await readPurchasingSetup(this.prisma, organizationId);
    const soonest = Math.min(...approvals.steps.map((step) => step.reminderDays ?? Infinity));
    if (soonest === Infinity) return 0;
    const waiting = await this.prisma.purchaseRequisition.findMany({
      where: { organizationId, status: Status.SUBMITTED, approvalRemindedAt: null, approvalRequestedAt: { lte: new Date(now.getTime() - soonest * DAY_MS) } },
      orderBy: { approvalRequestedAt: 'asc' },
      take: MOST_REMINDERS_A_RUN,
      select: { id: true, approvalRequestedAt: true, lines: { select: { quantity: true, estimatedUnitCostCents: true } } },
    });
    let reminded = 0;
    for (const requisition of waiting) {
      const { reminderDays } = approvalStepFor(requisitionTotalCents(requisition.lines), approvals.steps);
      if (reminderDays === null || requisition.approvalRequestedAt!.getTime() > now.getTime() - reminderDays * DAY_MS) continue;
      // Claimed first: a run that overlaps this one finds it reminded already.
      const claimed = await this.prisma.purchaseRequisition.updateMany({ where: { id: requisition.id, organizationId, status: Status.SUBMITTED, approvalRemindedAt: null }, data: { approvalRemindedAt: now } });
      if (!claimed.count) continue;
      await this.email(organizationId, requisition.id, true);
      reminded += 1;
    }
    return reminded;
  }

  private async email(organizationId: string, requisitionId: string, reminder: boolean): Promise<number> {
    const requisition = await this.prisma.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId, status: Status.SUBMITTED },
      select: {
        number: true,
        requestedById: true,
        requestedBy: { select: { displayName: true } },
        xeroTenantId: true,
        lines: { select: { quantity: true, estimatedUnitCostCents: true } },
      },
    });
    if (!requisition) return 0;
    const { approvals } = await readPurchasingSetup(this.prisma, organizationId);
    const totalCents = requisitionTotalCents(requisition.lines);
    const people = await this.approvers(organizationId, {
      requesterId: requisition.requestedById,
      steps: approvals.steps,
      totalCents,
      companyTenantId: requisition.xeroTenantId,
      ownCompaniesOnly: approvals.approverOwnCompaniesOnly,
    });
    if (!people.length) return 0;
    const company = requisition.xeroTenantId
      ? await this.prisma.xeroOrganisation.findFirst({ where: { organizationId, xeroTenantId: requisition.xeroTenantId }, select: { name: true } })
      : null;
    const number = requisition.number ?? 'A requisition';
    const origin = consoleOrigin();
    const link = origin ? `${origin}/purchasing/requisitions/${encodeURIComponent(requisitionId)}` : null;
    const subject = reminder ? `Reminder: ${number} is still waiting for your approval` : `${number} is waiting for your approval`;
    let sent = 0;
    for (const person of people) {
      const html = [
        `<p>Hello ${escapeHtml(person.name)},</p>`,
        `<p>${escapeHtml(requisition.requestedBy.displayName)} asks for <strong>${escapeHtml(formatMoney(totalCents))}</strong>${company ? ` for ${escapeHtml(company.name)}` : ''}, in requisition <strong>${escapeHtml(number)}</strong>.${reminder ? ' It is still waiting for a decision.' : ''}</p>`,
        link ? `<p><a href="${escapeHtml(link)}">Open the requisition</a> to approve it, send it back or reject it.</p>` : '<p>Open it in the console under Purchasing to approve it, send it back or reject it.</p>',
      ].join('');
      const result = await this.mail.sendRequisitionApproval({ to: person.email, subject, title: reminder ? 'Still waiting for your approval' : 'Waiting for your approval', html });
      if (result.status === 'SENT') sent += 1;
    }
    this.logger.log({ event: reminder ? 'requisition_approvers_reminded' : 'requisition_approvers_asked', organizationId, requisitionId, approvers: people.length, sent });
    return sent;
  }
}
