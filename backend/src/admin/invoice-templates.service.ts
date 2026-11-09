import { Inject, Injectable } from '@nestjs/common';
import {
  TEMPLATE_KINDS,
  TEMPLATE_KIND_LABEL,
  isEmailAddress,
  templateProblem,
  type EmailTemplatesView,
  type SaveEmailTemplatesInput,
} from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { readEmailTemplates } from './invoice-email-settings';

/**
 * The office's words for the invoice, receipt and statement emails, and where
 * a client's reply goes (2026-11-10, phase 4 of the invoice gap review), as
 * Jobber's "Emails & Text Messages" keeps them. Changed by whoever makes
 * invoices, saved against what was read, audited.
 */
@Injectable()
export class InvoiceTemplatesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(user: AuthenticatedUser): Promise<EmailTemplatesView> {
    const words = await readEmailTemplates(this.prisma, user.organizationId);
    return { templates: words.templates, replyTo: words.replyTo, companyEmail: words.companyEmail, updatedAt: words.updatedAt?.toISOString() ?? null };
  }

  async save(user: AuthenticatedUser, input: SaveEmailTemplatesInput): Promise<EmailTemplatesView> {
    for (const kind of TEMPLATE_KINDS) {
      const template = input.templates[kind];
      if (!template) throw new ApplicationError(422, 'EMAIL_TEMPLATES_INVALID', `The ${TEMPLATE_KIND_LABEL[kind].toLowerCase()} email is missing.`);
      const problem = templateProblem(kind, template);
      if (problem) throw new ApplicationError(422, 'EMAIL_TEMPLATES_INVALID', problem);
    }
    const replyTo = input.replyTo?.trim() || null;
    if (replyTo && !isEmailAddress(replyTo)) throw new ApplicationError(422, 'EMAIL_TEMPLATES_INVALID', 'Replies go to an email address.');
    const org = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const before = await readEmailTemplates(tx, org);
      const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
      if ((before.updatedAt?.toISOString() ?? null) !== expected)
        throw new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody else changed these first. Look again before saving.');
      const templates = Object.fromEntries(
        TEMPLATE_KINDS.map((kind) => [kind, { subject: input.templates[kind].subject.trim(), message: input.templates[kind].message.trim() }]),
      );
      const changes = [
        ...TEMPLATE_KINDS.filter((kind) => JSON.stringify(before.templates[kind]) !== JSON.stringify(templates[kind])).map(
          (kind) => `${TEMPLATE_KIND_LABEL[kind]} email changed`,
        ),
        before.replyTo !== replyTo ? `Replies: ${before.replyTo ?? 'the company email'} → ${replyTo ?? 'the company email'}` : null,
      ].filter((change): change is string => change !== null);
      if (!changes.length) return;
      const now = new Date();
      const values = { emailTemplates: templates, replyToEmail: replyTo, templatesUpdatedAt: now };
      await tx.invoiceSettings.upsert({ where: { organizationId: org }, create: { organizationId: org, ...values }, update: values });
      await tx.auditLog.create({
        data: {
          organizationId: org,
          actorUserId: user.id,
          action: 'INVOICE_EMAIL_TEMPLATES_CHANGED',
          entityType: 'InvoiceSettings',
          entityId: org,
          metadata: { changes },
        },
      });
    });
    return this.read(user);
  }
}
