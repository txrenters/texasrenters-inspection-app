import { ACCOUNT_ENTRY_LABEL, formatMoney, type AccountEntry, type StatementView } from '@texasrenters/shared';

import { escapeHtml } from './invoice-email';

/**
 * A property's statement as an email (2026-11-10, phase 3 of the invoice gap
 * review): its billing history over the period chosen, in the office's order,
 * what was owed before it and what is owed now, and the office's text at the
 * foot -- the PDF's content, written into the email.
 */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (value: string | null) => (value ? DAY.format(new Date(`${value}T12:00:00.000Z`)) : '—');
const cell = 'padding:8px 6px;border-bottom:1px solid #d9e2ef;text-align:left;vertical-align:top';
const money = `${cell};text-align:right;white-space:nowrap`;

export const entryName = (entry: AccountEntry) =>
  entry.kind === 'INVOICE' && entry.invoiceNumber ? `Invoice #${entry.invoiceNumber}` : ACCOUNT_ENTRY_LABEL[entry.kind];

/** What the entry was applied to: the invoice a payment paid, and nothing for an invoice. */
export const appliedTo = (entry: AccountEntry) =>
  entry.kind === 'INVOICE' ? '' : entry.invoiceNumber ? `Invoice #${entry.invoiceNumber}` : 'Its invoice';

export function statementEmail(view: StatementView) {
  const rows = view.newestFirst ? [...view.entries].reverse() : view.entries;
  const forward =
    view.from && view.openingBalanceCents !== 0
      ? `<tr><td style="${cell}">${escapeHtml(day(view.from))}</td><td style="${cell}" colspan="2">Balance forward</td><td style="${money}"></td><td style="${money}">${escapeHtml(formatMoney(view.openingBalanceCents))}</td></tr>`
      : '';
  const lines = rows
    .map(
      (entry) =>
        `<tr><td style="${cell}">${escapeHtml(day(entry.on))}</td><td style="${cell}">${escapeHtml(entryName(entry))}</td><td style="${cell};color:#5b6b87">${escapeHtml(appliedTo(entry))}</td><td style="${money}">${escapeHtml(formatMoney(entry.amountCents))}</td><td style="${money}">${escapeHtml(formatMoney(entry.balanceCents))}</td></tr>`,
    )
    .join('');
  const owed = view.closingBalanceCents;
  const standing =
    owed > 0
      ? `Your balance is <strong>${escapeHtml(formatMoney(owed))}</strong>.`
      : owed < 0
        ? `You have a credit of <strong>${escapeHtml(formatMoney(-owed))}</strong>.`
        : 'Your account is paid in full.';
  const contact = view.brand.email ? ` at ${view.brand.email}` : '';
  const html = `<p style="margin:0 0 12px">Hi ${escapeHtml(view.clientName)},</p>
    <p style="margin:0 0 12px">Here is your statement from ${escapeHtml(view.brand.name)} as of ${escapeHtml(day(view.on))}. ${standing}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;margin:4px 0 16px" role="presentation">
      <tr><th style="${cell}">Date</th><th style="${cell}">Item</th><th style="${cell}">Applied to</th><th style="${money}">Amount</th><th style="${money}">Balance</th></tr>
      ${view.newestFirst ? '' : forward}${lines || `<tr><td style="${cell}" colspan="5">Nothing was billed or paid in this period.</td></tr>`}${view.newestFirst ? forward : ''}
      <tr><td style="${cell};font-weight:700" colspan="4">Balance due</td><td style="${money};font-weight:700">${escapeHtml(formatMoney(Math.max(0, owed)))}</td></tr>
    </table>
    <p style="margin:0 0 12px">If you have any questions, please get in touch with us${escapeHtml(contact)}.</p>
    <p style="margin:0 0 12px">Sincerely,<br>${escapeHtml(view.brand.name)}</p>
    ${view.disclaimer ? `<p style="margin:16px 0 0;color:#5b6b87;font-size:12px;white-space:pre-line">${escapeHtml(view.disclaimer)}</p>` : ''}`;
  return {
    subject: `Your statement from ${view.brand.name}`,
    title: `Statement for ${view.clientName}: ${formatMoney(Math.max(0, owed))} due`,
    html,
  };
}
