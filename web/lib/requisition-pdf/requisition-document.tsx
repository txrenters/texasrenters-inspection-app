import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { approvalStepFor, approvalStepRange, requisitionTotalCents, type RequisitionDetail, type RequisitionLine, type RequisitionStatus } from '@texasrenters/shared';

import { coded, fromLines, navAmount, navDay, navMoment, navStyles as styles } from '../nav-pdf/nav-pdf';

/**
 * A purchase requisition as a PDF (2026-11-20, part 4), laid out as the
 * approved PrPdf board: a landscape page in black on white, as NAV prints one.
 * The company, "Purchase Requisition", its number and a status stamp; the
 * header's facts in three columns; every line with its codes and any note
 * under it; the totals; and three boxes -- who asked, who approved, and the
 * purchase orders it became.
 *
 * Made in the browser from what the requisition's page already holds: no
 * images, nothing asked of the server, nothing billed. A line is never split
 * across two pages, and the table's heading repeats on each.
 */

const own = StyleSheet.create({
  fact: { width: '33.33%' },
  joined: { borderBottomWidth: 0 },
  note: { fontSize: 9, color: '#333333', fontFamily: 'Helvetica-Oblique', paddingTop: 0 },
});

/** The lines' columns, as the board draws them, adding up to the page's width. */
const COLUMNS = [
  { label: 'Type', width: '7%' },
  { label: 'Item Code', width: '10%' },
  { label: 'Description', width: '18%' },
  { label: 'Location', width: '8%' },
  { label: 'Quantity', width: '7%', right: true },
  { label: 'UoM', width: '6%' },
  { label: 'Direct Unit Cost', width: '9%', right: true },
  { label: 'Line Amount', width: '9%', right: true },
  { label: 'Expected Receipt', width: '9%' },
  { label: 'Vendor No.', width: '8%' },
  { label: 'Department', width: '9%' },
] as const;

/** The stamp, in NAV's words where they differ: an approved requisition is Released. */
const STAMP: Record<RequisitionStatus, string> = {
  DRAFT: 'OPEN',
  SUBMITTED: 'PENDING APPROVAL',
  SENT_BACK: 'SENT BACK',
  APPROVED: 'RELEASED',
  ORDERED: 'ORDERED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED',
};

/** The header's facts, read across the three columns as the board lays them out. */
export function requisitionFacts(requisition: RequisitionDetail): { label: string; value: string }[] {
  const company = requisition.company;
  return [
    { label: 'Requisitioner ID', value: requisition.requestedBy.code },
    { label: 'Request Code', value: coded(requisition.requestCode) },
    { label: 'Requisition Date', value: navDay(requisition.requisitionDate) },
    { label: 'Requisitioner Name', value: requisition.requestedBy.name },
    { label: 'Location Code', value: coded(requisition.deliverTo) },
    { label: 'Document Date', value: navDay(requisition.documentDate) },
    { label: 'Purchaser Code', value: company ? coded({ code: company.purchaserCode, name: company.name }) : '' },
    { label: 'Cost Center Code', value: requisition.costCenter?.code ?? '' },
    { label: 'Expected Receipt', value: navDay(requisition.neededBy) },
  ];
}

/** One line's cells, in the columns' order. A line names its own place and day, else the requisition's. */
export function requisitionLineCells(line: RequisitionLine, requisition: Pick<RequisitionDetail, 'deliverTo' | 'neededBy'>): string[] {
  return [
    line.lineType?.name ?? '',
    // A deleted item code (2026-11-24) still prints, and says so.
    line.item ? (line.item.deleted ? `${line.item.code} (deleted)` : line.item.code) : '',
    line.description ?? line.item?.name ?? '',
    line.place?.code ?? requisition.deliverTo?.code ?? '',
    String(line.quantity),
    (line.item?.unit ?? '').toUpperCase(),
    navAmount(line.estimatedUnitCostCents),
    navAmount(line.quantity * line.estimatedUnitCostCents),
    navDay(line.expectedOn ?? requisition.neededBy),
    line.vendor?.number ?? '',
    line.department?.code ?? '',
  ];
}

/** "PO-0031 · V00003 Hill Country Supply", one for each live order it became. */
export function orderedAs(requisition: Pick<RequisitionDetail, 'orders'>): string[] {
  return requisition.orders.map((order) => {
    const vendor = order.vendor ? `${order.vendor.number ? `${order.vendor.number} ` : ''}${order.vendor.name}` : 'vendor to choose';
    return `${order.number ?? 'Draft order'} · ${vendor}`;
  });
}

/** The approval step its amount fell in (Purchasing Setup, 2026-11-20): "$500.01 to $5,000.00". */
export function approvalStep(requisition: Pick<RequisitionDetail, 'settings'>, totalCents: number): string {
  const { steps } = requisition.settings;
  return approvalStepRange(steps, steps.indexOf(approvalStepFor(totalCents, steps)));
}

/** Approved, and by whom: only once it has been. A requisition sent back or rejected was decided, not approved. */
const APPROVED: readonly RequisitionStatus[] = ['APPROVED', 'ORDERED', 'CLOSED'];

export function RequisitionDocument({ requisition, printedBy, printedAt = new Date() }: { requisition: RequisitionDetail; printedBy?: string | null; printedAt?: Date }) {
  const from = requisition.from;
  const { address, contact } = fromLines(from);
  const number = requisition.number ?? 'Draft';
  const totalCents = requisitionTotalCents(requisition.lines);
  const approved = APPROVED.includes(requisition.status) && requisition.decidedBy;
  const orders = orderedAs(requisition);

  return (
    <Document author={from.name} title={`Purchase Requisition ${number}`}>
      <Page orientation="landscape" size="LETTER" style={styles.page}>
        <View style={styles.top}>
          <View>
            <Text style={styles.company}>{from.name}</Text>
            {address ? <Text style={styles.fromLine}>{address}</Text> : null}
            {contact ? <Text style={styles.fromLine}>{contact}</Text> : null}
          </View>
          <View style={styles.titleBox}>
            <Text style={styles.title}>Purchase Requisition</Text>
            <Text style={styles.number}>{number}</Text>
            <Text style={styles.stamp}>{STAMP[requisition.status]}</Text>
          </View>
        </View>
        <View style={styles.rule} />

        <View style={styles.facts}>
          {requisitionFacts(requisition).map((fact) => (
            <View key={fact.label} style={[styles.fact, own.fact]}>
              <Text style={styles.factLabel}>{fact.label}</Text>
              <Text style={styles.factValue}>{fact.value}</Text>
            </View>
          ))}
        </View>

        <View fixed style={styles.head}>
          {COLUMNS.map((column) => (
            <Text key={column.label} style={[styles.th, { width: column.width }, 'right' in column ? styles.right : {}]}>
              {column.label}
            </Text>
          ))}
        </View>
        {requisition.lines.map((line) => (
          <View key={line.id} wrap={false}>
            <View style={[styles.row, line.notes ? own.joined : {}]}>
              {requisitionLineCells(line, requisition).map((cell, index) => {
                const column = COLUMNS[index]!;
                return (
                  <Text key={column.label} style={[styles.td, { width: column.width }, 'right' in column ? styles.right : {}]}>
                    {cell}
                  </Text>
                );
              })}
            </View>
            {line.notes ? (
              <View style={styles.row}>
                <Text style={[styles.td, own.note, { width: COLUMNS[0].width }]} />
                <Text style={[styles.td, own.note, { width: '93%' }]}>Note: {line.notes}</Text>
              </View>
            ) : null}
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.total}>
            <Text>Lines</Text>
            <Text style={styles.bold}>{requisition.lines.length}</Text>
          </View>
          <View style={styles.total}>
            <Text>Total Excl. Tax (USD)</Text>
            <Text style={styles.bold}>{navAmount(totalCents)}</Text>
          </View>
          {/* A requisition estimates its cost; the sales tax is worked out on the purchase order. */}
          <View style={styles.total}>
            <Text>Total Tax (USD)</Text>
            <Text style={styles.bold}>{navAmount(0)}</Text>
          </View>
          <View style={[styles.total, styles.grand]}>
            <Text style={styles.bold}>Total (USD)</Text>
            <Text style={styles.bold}>{navAmount(totalCents)}</Text>
          </View>
        </View>

        <View style={styles.signs} wrap={false}>
          <View style={styles.sign}>
            <View style={styles.signText}>
              <Text style={styles.boxHead}>Requested by</Text>
              <Text>
                {requisition.requestedBy.name}
                {requisition.requestedBy.code ? ` (${requisition.requestedBy.code})` : ''}
              </Text>
              <Text style={styles.muted}>{requisition.submittedAt ? `Sent for approval ${navMoment(requisition.submittedAt)}` : 'Not sent for approval yet'}</Text>
            </View>
            <Text style={styles.signLine}>Signature</Text>
          </View>
          <View style={[styles.sign, styles.signGap]}>
            <View style={styles.signText}>
              <Text style={styles.boxHead}>Approved by</Text>
              {approved ? (
                <>
                  <Text>{requisition.decidedBy}</Text>
                  <Text style={styles.muted}>
                    {requisition.decidedAt ? `Approved in the console ${navMoment(requisition.decidedAt)}` : 'Approved in the console'} · {approvalStep(requisition, totalCents)} step
                  </Text>
                </>
              ) : (
                <Text style={styles.muted}>Not approved yet</Text>
              )}
            </View>
            <Text style={styles.signLine}>Signature</Text>
          </View>
          <View style={[styles.sign, styles.signGap]}>
            <Text style={styles.boxHead}>Ordered as</Text>
            {orders.length ? orders.map((order) => <Text key={order}>{order}</Text>) : <Text style={styles.muted}>No purchase order yet</Text>}
          </View>
        </View>

        <View fixed style={styles.footer}>
          <Text>
            Printed {navMoment(printedAt)} Texas time{printedBy ? ` · ${printedBy}` : ''}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${number} · Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
