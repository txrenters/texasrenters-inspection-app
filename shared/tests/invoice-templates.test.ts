import { describe, expect, it } from 'vitest';

import { accountBalanceLine, invoiceTemplateValues, showsLateStamp } from '../src/contracts/invoice-delivery';
import {
  DEFAULT_CLIENT_VIEW,
  DEFAULT_EMAIL_TEMPLATES,
  fillTemplate,
  templateProblem,
  templatesFrom,
  unknownPlaceholders,
} from '../src/contracts/invoice-templates';

describe('email templates', () => {
  it('fill the placeholders they know, and leave a typo as written', () => {
    expect(fillTemplate('Hi {{client_name}}, {{ balance_due }} is due. {{clinet_name}}', { client_name: '100 Example Way', balance_due: '$39.99' })).toBe(
      'Hi 100 Example Way, $39.99 is due. {{clinet_name}}',
    );
  });

  it('say which placeholders an email does not know', () => {
    expect(unknownPlaceholders('receipt', { subject: 'Thanks {{payment_amount}}', message: 'Due {{due_date}}' })).toEqual(['due_date']);
    expect(templateProblem('receipt', { subject: 'Thanks', message: 'Due {{due_date}}' })).toBe('{{due_date}} is not something the payment receipt email knows.');
    expect(templateProblem('invoice', { subject: ' ', message: '' })).toBe('Give the invoice email a subject.');
    for (const [kind, template] of Object.entries(DEFAULT_EMAIL_TEMPLATES))
      expect(templateProblem(kind as keyof typeof DEFAULT_EMAIL_TEMPLATES, template)).toBeNull();
  });

  it("take the office's words over the console's, field by field", () => {
    const words = templatesFrom({ invoice: { subject: 'Invoice {{invoice_number}}' }, receipt: { subject: '', message: '' } });
    expect(words.invoice).toEqual({ subject: 'Invoice {{invoice_number}}', message: DEFAULT_EMAIL_TEMPLATES.invoice.message });
    // An empty subject keeps the console's; an empty message is the office choosing none.
    expect(words.receipt).toEqual({ subject: DEFAULT_EMAIL_TEMPLATES.receipt.subject, message: '' });
    expect(templatesFrom(null)).toEqual(DEFAULT_EMAIL_TEMPLATES);
  });

  it('fill an invoice email the same on the page and the server', () => {
    const values = invoiceTemplateValues(
      { clientName: '100 Example Way', number: '8439', subject: 'Quarterly', totalCents: 6499, balanceCents: 2500, issuedOn: '2026-11-01', dueOn: '2026-12-01' },
      'Example Homes',
    );
    expect(fillTemplate(DEFAULT_EMAIL_TEMPLATES.invoice.subject, values)).toBe('Invoice #8439 from Example Homes');
    expect(fillTemplate(DEFAULT_EMAIL_TEMPLATES.invoice.message, values)).toBe(
      'Hello,\n\nHere is invoice #8439 for 100 Example Way: $25.00 is due by Dec 1, 2026.\n\nThank you.',
    );
  });
});

describe('the client view', () => {
  it('prints the account balance when on and known, and the late stamp only on a past-due invoice', () => {
    expect(accountBalanceLine({ accountBalanceCents: 10498 })).toEqual({ label: 'Account balance', value: '$104.98' });
    expect(accountBalanceLine({ accountBalanceCents: null })).toBeNull();
    expect(accountBalanceLine({ accountBalanceCents: 10498, clientView: { ...DEFAULT_CLIENT_VIEW, showAccountBalance: false } })).toBeNull();
    expect(showsLateStamp({ status: 'PAST_DUE' })).toBe(true);
    expect(showsLateStamp({ status: 'AWAITING_PAYMENT' })).toBe(false);
    expect(showsLateStamp({ status: 'PAST_DUE', clientView: { ...DEFAULT_CLIENT_VIEW, showLateStamp: false } })).toBe(false);
  });
});
