import {
  formatMoney,
  invoiceDocumentName,
  overdueWords,
  PAYMENT_METHOD_LABEL,
  type InvoiceDetail,
  type PaymentDetail,
  type ReceiptBrand,
  DEFAULT_EMAIL_TEMPLATES,
  fillTemplate,
  type EmailTemplate,
} from '@texasrenters/shared';

import { escapeHtml, invoiceEmail, paragraphs } from './invoice-email';

/**
 * The follow-up and receipt emails (2026-11-09), in Jobber's own words so a
 * client reads what they always have. Every value is escaped.
 */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (value: string) => DAY.format(new Date(`${value}T12:00:00.000Z`));

/**
 * Jobber's follow-up: "Your invoice from {company} is {due today | N days
 * overdue}", a short reminder, then the invoice itself as the invoice email
 * writes it, so the client has what they owe in front of them.
 */
export function followUpEmail(invoice: InvoiceDetail, brand: ReceiptBrand, daysLate: number) {
  const words = overdueWords(daysLate);
  const reminder = [
    `Hi ${invoice.clientName},`,
    `This is a reminder that payment on ${invoiceDocumentName(invoice)} is ${words}.`,
    'If the payment has already been sent, please ignore this email.',
    `Thanks,\n${brand.name}`,
  ].join('\n\n');
  const email = invoiceEmail(invoice, brand, reminder);
  return { ...email, subject: `Your invoice from ${brand.name} is ${words}` };
}

/** Jobber's receipt: "Receipt for payment from {company} - {day}", and what was paid. */
/** A receipt email's placeholders, filled. */
export function receiptTemplateValues(payment: PaymentDetail, brand: ReceiptBrand): Record<string, string> {
  return {
    client_name: payment.invoice.clientName,
    company_name: brand.name,
    payment_amount: formatMoney(payment.amountCents),
    payment_date: day(payment.paidOn),
    invoice_number: payment.invoice.number ?? '',
    balance_due: formatMoney(payment.invoiceBalanceCents),
  };
}

export function receiptEmail(payment: PaymentDetail, brand: ReceiptBrand, template: EmailTemplate = DEFAULT_EMAIL_TEMPLATES.receipt) {
  const values = receiptTemplateValues(payment, brand);
  const rows: [string, string][] = [
    ['Payment date', day(payment.paidOn)],
    ['Amount', formatMoney(payment.amountCents)],
    ['Method', PAYMENT_METHOD_LABEL[payment.method]],
    ...(payment.reference ? ([['Reference', payment.reference]] as [string, string][]) : []),
    ['Applied to', invoiceDocumentName(payment.invoice)],
    ['Still owed on it', formatMoney(payment.invoiceBalanceCents)],
  ];
  const contact = brand.email ? ` at ${brand.email}` : '';
  const intro = fillTemplate(template.message, values).trim();
  const html = `${intro ? paragraphs(intro) : ''}
    <table style="border-collapse:collapse;font-size:14px;margin:4px 0 16px" role="presentation">
      ${rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#5b6b87">${escapeHtml(label)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}
    </table>
    <p style="margin:0 0 12px">If you have any questions or concerns, please don't hesitate to get in touch with us${escapeHtml(contact)}.</p>
    <p style="margin:0">Sincerely,<br>${escapeHtml(brand.name)}</p>`;
  return {
    subject: fillTemplate(template.subject, values),
    title: `Receipt: ${formatMoney(payment.amountCents)} received ${day(payment.paidOn)}`,
    html,
  };
}
