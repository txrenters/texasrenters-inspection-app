/**
 * The invoice itself (2026-11-10, phase 4 of the invoice gap review):
 *
 * - **Client view:** Jobber's five switches for what the client sees on the
 *   invoice's PDF and email.
 * - **Email templates:** the office's words for the invoice, receipt and
 *   statement emails, with Jobber-style placeholders, and where a reply goes.
 * - **The PDF attached:** the invoice's PDF, made in the browser on the press,
 *   attached to the email it is sent with.
 */

/** Jobber's "Client view": every one on unless the office turns it off for an invoice. */
export interface InvoiceClientView {
  showQuantities: boolean;
  showUnitPrices: boolean;
  showLineTotals: boolean;
  showAccountBalance: boolean;
  /** "Late stamp (if overdue)". */
  showLateStamp: boolean;
}

export const DEFAULT_CLIENT_VIEW: InvoiceClientView = {
  showQuantities: true,
  showUnitPrices: true,
  showLineTotals: true,
  showAccountBalance: true,
  showLateStamp: true,
};

export const CLIENT_VIEW_LABEL: Record<keyof InvoiceClientView, string> = {
  showQuantities: 'Quantities',
  showUnitPrices: 'Unit prices',
  showLineTotals: 'Line item totals',
  showAccountBalance: 'Account balance',
  showLateStamp: 'Late stamp (if overdue)',
};

export const TEMPLATE_KINDS = ['invoice', 'receipt', 'statement'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, string> = {
  invoice: 'Invoice',
  receipt: 'Payment receipt',
  statement: 'Statement',
};

export interface EmailTemplate {
  subject: string;
  /** Plain text, a blank line between paragraphs. Above the invoice, receipt or statement the email carries. */
  message: string;
}

export type EmailTemplates = Record<TemplateKind, EmailTemplate>;

/** The console's own words, which every office starts with. */
export const DEFAULT_EMAIL_TEMPLATES: EmailTemplates = {
  invoice: {
    subject: 'Invoice #{{invoice_number}} from {{company_name}}',
    message: 'Hello,\n\nHere is invoice #{{invoice_number}} for {{client_name}}: {{balance_due}} is due by {{due_date}}.\n\nThank you.',
  },
  receipt: {
    subject: 'Receipt for payment from {{company_name}} - {{payment_date}}',
    message: 'Hi {{client_name}},\n\nThis is your receipt for your payment of {{payment_amount}}. Please keep this email for your reference.',
  },
  statement: {
    subject: 'Your statement from {{company_name}}',
    message: 'Hi {{client_name}},\n\nHere is your statement from {{company_name}} as of {{statement_date}}.',
  },
};

/** What each template may say, as Jobber lists its variables. */
export const TEMPLATE_PLACEHOLDERS: Record<TemplateKind, { key: string; label: string }[]> = {
  invoice: [
    { key: 'client_name', label: 'Client name' },
    { key: 'company_name', label: 'Company name' },
    { key: 'invoice_number', label: 'Invoice number' },
    { key: 'invoice_subject', label: 'Invoice subject' },
    { key: 'invoice_total', label: 'Invoice total' },
    { key: 'balance_due', label: 'Balance due' },
    { key: 'issued_date', label: 'Issued date' },
    { key: 'due_date', label: 'Due date' },
  ],
  receipt: [
    { key: 'client_name', label: 'Client name' },
    { key: 'company_name', label: 'Company name' },
    { key: 'payment_amount', label: 'Payment amount' },
    { key: 'payment_date', label: 'Payment date' },
    { key: 'invoice_number', label: 'Invoice number' },
    { key: 'balance_due', label: 'Still owed on the invoice' },
  ],
  statement: [
    { key: 'client_name', label: 'Client name' },
    { key: 'company_name', label: 'Company name' },
    { key: 'statement_date', label: 'Statement date' },
    { key: 'balance_due', label: 'Balance due' },
  ],
};

export const MAX_TEMPLATE_SUBJECT = 200;
export const MAX_TEMPLATE_MESSAGE = 4000;

/** `{{ name }}` filled from the values; a placeholder it does not know is left as written, so a typo shows. */
export function fillTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key: string) => values[key.toLowerCase()] ?? whole);
}

/** The placeholders a template uses that its kind does not have. */
export function unknownPlaceholders(kind: TemplateKind, template: EmailTemplate): string[] {
  const known = new Set(TEMPLATE_PLACEHOLDERS[kind].map((item) => item.key));
  const used = [...`${template.subject}\n${template.message}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((match) => match[1]!.toLowerCase());
  return [...new Set(used.filter((key) => !known.has(key)))];
}

/** What is wrong with a template, in words; null when it can be kept. */
export function templateProblem(kind: TemplateKind, template: EmailTemplate): string | null {
  if (!template.subject.trim()) return `Give the ${TEMPLATE_KIND_LABEL[kind].toLowerCase()} email a subject.`;
  if (template.subject.length > MAX_TEMPLATE_SUBJECT) return `Keep the subject under ${MAX_TEMPLATE_SUBJECT} characters.`;
  if (template.message.length > MAX_TEMPLATE_MESSAGE) return `Keep the message under ${MAX_TEMPLATE_MESSAGE} characters.`;
  const unknown = unknownPlaceholders(kind, template);
  if (unknown.length) return `${unknown.map((key) => `{{${key}}}`).join(', ')} is not something the ${TEMPLATE_KIND_LABEL[kind].toLowerCase()} email knows.`;
  return null;
}

/** The office's templates over the console's own, field by field. */
export function templatesFrom(saved: unknown): EmailTemplates {
  const value = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<TemplateKind, Partial<EmailTemplate>>>;
  return Object.fromEntries(
    TEMPLATE_KINDS.map((kind) => [
      kind,
      {
        subject: typeof value[kind]?.subject === 'string' && value[kind]!.subject!.trim() ? value[kind]!.subject! : DEFAULT_EMAIL_TEMPLATES[kind].subject,
        message: typeof value[kind]?.message === 'string' ? value[kind]!.message! : DEFAULT_EMAIL_TEMPLATES[kind].message,
      },
    ]),
  ) as EmailTemplates;
}

export interface EmailTemplatesView {
  templates: EmailTemplates;
  /** Where a client's reply goes; null sends it to the company email. */
  replyTo: string | null;
  /** The company email, which a reply goes to when no other is set. */
  companyEmail: string | null;
  updatedAt: string | null;
}

export interface SaveEmailTemplatesInput {
  templates: EmailTemplates;
  replyTo: string | null;
  expectedUpdatedAt: string | null;
}

/** The invoice's PDF, made in the browser, sent with the press. */
export interface InvoiceEmailAttachment {
  fileName: string;
  /** The PDF's bytes, base64. */
  contentBase64: string;
}

/** The largest PDF attached: an invoice has no images, so a long one is still a few pages. */
export const MAX_ATTACHED_PDF_BYTES = 60_000;
