import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAYMENT_METHOD_LABEL, REPORT_PALETTE, formatMoney, type PaymentDetail } from '@texasrenters/shared';

/**
 * A payment receipt (2026-11-06), as Jobber's "Download PDF" on a payment:
 * from the company, for the property, how much came in, when and how, the
 * invoice it went to and what that still owes. One page, no images, so it
 * renders in the browser from what the payment page already holds.
 */

const C = REPORT_PALETTE;

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, color: C.text, fontFamily: 'Helvetica' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 28 },
  brand: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: C.brand },
  brandLine: { color: C.muted, marginTop: 2 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: C.brandDark, textAlign: 'right' },
  subtitle: { color: C.muted, textAlign: 'right', marginTop: 4 },
  amountBox: { backgroundColor: C.brandSoft, borderRadius: 6, padding: 16, marginBottom: 24 },
  amountLabel: { color: C.muted, textTransform: 'uppercase', fontSize: 8, letterSpacing: 1 },
  amount: { fontSize: 26, fontFamily: 'Helvetica-Bold', color: C.brandDark, marginTop: 4 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 6 },
  label: { width: '40%', color: C.muted },
  value: { width: '60%' },
  strong: { fontFamily: 'Helvetica-Bold' },
  footer: { position: 'absolute', bottom: 36, left: 48, right: 48, color: C.muted, fontSize: 8, textAlign: 'center' },
});

/** "Oct 20, 2026": a payment's day, which is a date and never a moment. */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const receiptDay = (day: string) => DAY.format(new Date(`${day}T12:00:00.000Z`));

/** The receipt's rows, in the order they print; empty ones left out. */
export function receiptRows(payment: PaymentDetail): { label: string; value: string; strong?: boolean }[] {
  const invoice = payment.invoice.number ? `#${payment.invoice.number}` : payment.invoice.subject;
  const rows: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Payment date', value: receiptDay(payment.paidOn) },
    { label: 'Method', value: PAYMENT_METHOD_LABEL[payment.method] },
  ];
  if (payment.reference) rows.push({ label: 'Reference', value: payment.reference });
  rows.push(
    { label: 'Applied to invoice', value: invoice },
    { label: 'Invoice total', value: formatMoney(payment.invoiceTotalCents) },
    { label: 'Balance remaining', value: formatMoney(payment.invoiceBalanceCents), strong: true },
  );
  return rows;
}

export function ReceiptDocument({ payment }: { payment: PaymentDetail }) {
  const brand = payment.brand;
  const place = payment.property
    ? [payment.property.address, payment.property.city].filter(Boolean).join(', ')
    : payment.invoice.clientName;
  return (
    <Document author={brand.name} creator={brand.name} producer={brand.name} title={`Receipt ${receiptDay(payment.paidOn)}`}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{brand.name}</Text>
            {[brand.addressLine1, brand.addressLine2, brand.phone, brand.email]
              .filter((line): line is string => Boolean(line))
              .map((line) => (
                <Text key={line} style={styles.brandLine}>
                  {line}
                </Text>
              ))}
          </View>
          <View>
            <Text style={styles.title}>Receipt</Text>
            <Text style={styles.subtitle}>{receiptDay(payment.paidOn)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Received for</Text>
          <Text style={styles.strong}>{payment.invoice.clientName}</Text>
          {place !== payment.invoice.clientName ? <Text style={styles.brandLine}>{place}</Text> : null}
        </View>

        <View style={styles.amountBox}>
          <Text style={styles.amountLabel}>Amount received</Text>
          <Text style={styles.amount}>{formatMoney(payment.amountCents)}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment</Text>
          {receiptRows(payment).map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={row.strong ? [styles.value, styles.strong] : styles.value}>{row.value}</Text>
            </View>
          ))}
        </View>

        {payment.note ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Details</Text>
            <Text>{payment.note}</Text>
          </View>
        ) : null}

        <Text style={styles.footer}>Thank you. This receipt records a payment already received; no card was charged.</Text>
      </Page>
    </Document>
  );
}
