import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { ACCOUNT_ENTRY_LABEL, REPORT_PALETTE, formatMoney, type AccountEntry, type StatementView } from '@texasrenters/shared';

/**
 * A property's statement as a PDF (2026-11-10, phase 3 of the invoice gap
 * review), as Jobber's "Download PDF" on a statement: from the company, for
 * the property, its billing history over the period in the office's order
 * with the balance after each line, what was carried forward, what is owed
 * now, and the office's text at the foot.
 *
 * Laid out as the reports learned to break pages (PR #481): a line is never
 * split, the table's heading repeats, and nothing breakable carries a bottom
 * margin.
 */

const C = REPORT_PALETTE;

const styles = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 64, paddingHorizontal: 48, fontSize: 10, color: C.text, fontFamily: 'Helvetica' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  brand: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: C.brand },
  muted: { color: C.muted, marginTop: 2 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', color: C.brandDark, textAlign: 'right' },
  subtitle: { color: C.muted, textAlign: 'right', marginTop: 4 },
  parties: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  sectionTitle: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  strong: { fontFamily: 'Helvetica-Bold' },
  dueBox: { backgroundColor: C.brandSoft, borderRadius: 6, padding: 12, width: '40%' },
  due: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: C.brandDark, marginTop: 4 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.text, paddingBottom: 4 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 6 },
  date: { width: '16%' },
  item: { width: '30%', paddingRight: 6 },
  applied: { width: '22%', paddingRight: 6, color: C.muted },
  money: { width: '16%', textAlign: 'right' },
  head: { fontSize: 8, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
  closing: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: C.text, paddingTop: 6, marginLeft: 'auto', width: '45%' },
  note: { paddingTop: 18 },
  footer: { position: 'absolute', bottom: 28, left: 48, right: 48, color: C.muted, fontSize: 8, flexDirection: 'row', justifyContent: 'space-between' },
});

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const statementDay = (day: string | null) => (day ? DAY.format(new Date(`${day}T12:00:00.000Z`)) : '—');

export const entryName = (entry: AccountEntry) =>
  entry.kind === 'INVOICE' && entry.invoiceNumber ? `Invoice #${entry.invoiceNumber}` : ACCOUNT_ENTRY_LABEL[entry.kind];
export const appliedTo = (entry: AccountEntry) =>
  entry.kind === 'INVOICE' ? '' : entry.invoiceNumber ? `Invoice #${entry.invoiceNumber}` : 'Its invoice';

/** The lines as they print: the office's order, with the balance carried forward where it began. */
export function statementLines(view: StatementView) {
  const entries = view.newestFirst ? [...view.entries].reverse() : view.entries;
  const forward = view.from && view.openingBalanceCents !== 0 ? [{ forward: true as const, on: view.from, balanceCents: view.openingBalanceCents }] : [];
  const lines = entries.map((entry) => ({ forward: false as const, entry }));
  return view.newestFirst ? [...lines, ...forward] : [...forward, ...lines];
}

export function StatementDocument({ view }: { view: StatementView }) {
  const owed = view.closingBalanceCents;
  const name = `Statement for ${view.clientName}`;
  return (
    <Document author={view.brand.name} creator={view.brand.name} producer={view.brand.name} title={name}>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>{view.brand.name}</Text>
            {[view.brand.addressLine1, view.brand.addressLine2, view.brand.phone, view.brand.email]
              .filter((line): line is string => Boolean(line))
              .map((line) => (
                <Text key={line} style={styles.muted}>
                  {line}
                </Text>
              ))}
          </View>
          <View>
            <Text style={styles.title}>Statement</Text>
            <Text style={styles.subtitle}>As of {statementDay(view.on)}</Text>
          </View>
        </View>

        <View style={styles.parties}>
          <View style={{ width: '55%' }}>
            <Text style={styles.sectionTitle}>Statement for</Text>
            <Text style={styles.strong}>{view.clientName}</Text>
            {view.address && view.address !== view.clientName ? <Text style={styles.muted}>{view.address}</Text> : null}
            <Text style={[styles.muted, { marginTop: 8 }]}>
              {view.period === 'LIFETIME' ? 'Every invoice and payment' : `From ${statementDay(view.from)}`}
            </Text>
          </View>
          <View style={styles.dueBox}>
            <Text style={styles.sectionTitle}>{owed < 0 ? 'In credit' : 'Balance due'}</Text>
            <Text style={styles.due}>{formatMoney(Math.abs(owed))}</Text>
          </View>
        </View>

        <View fixed style={styles.tableHead}>
          <Text style={[styles.date, styles.head]}>Date</Text>
          <Text style={[styles.item, styles.head]}>Item</Text>
          <Text style={[styles.applied, styles.head]}>Applied to</Text>
          <Text style={[styles.money, styles.head]}>Amount</Text>
          <Text style={[styles.money, styles.head]}>Balance</Text>
        </View>
        {statementLines(view).map((line) =>
          line.forward ? (
            <View key="forward" style={styles.row} wrap={false}>
              <Text style={styles.date}>{statementDay(line.on)}</Text>
              <Text style={[styles.item, styles.strong]}>Balance forward</Text>
              <Text style={styles.applied} />
              <Text style={styles.money} />
              <Text style={styles.money}>{formatMoney(line.balanceCents)}</Text>
            </View>
          ) : (
            <View key={line.entry.key} style={styles.row} wrap={false}>
              <Text style={styles.date}>{statementDay(line.entry.on)}</Text>
              <Text style={styles.item}>{entryName(line.entry)}</Text>
              <Text style={styles.applied}>{appliedTo(line.entry)}</Text>
              <Text style={styles.money}>{formatMoney(line.entry.amountCents)}</Text>
              <Text style={styles.money}>{formatMoney(line.entry.balanceCents)}</Text>
            </View>
          ),
        )}
        {view.entries.length ? null : (
          <View style={styles.row} wrap={false}>
            <Text style={{ color: C.muted }}>Nothing was billed or paid in this period.</Text>
          </View>
        )}

        <View style={{ paddingTop: 10 }} wrap={false}>
          <View style={styles.closing}>
            <Text style={styles.strong}>{owed < 0 ? 'In credit' : 'Balance due'}</Text>
            <Text style={styles.strong}>{formatMoney(Math.abs(owed))}</Text>
          </View>
        </View>

        {view.disclaimer ? (
          <View style={styles.note}>
            <Text style={{ color: C.muted, fontSize: 9 }}>{view.disclaimer}</Text>
          </View>
        ) : null}

        <View fixed style={styles.footer}>
          <Text>
            {view.brand.name} · {name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : '')} />
        </View>
      </Page>
    </Document>
  );
}
