import { StyleSheet } from '@react-pdf/renderer';

import { BUSINESS_TIME_ZONE } from '../clock';

/**
 * What the purchasing PDFs share (2026-11-20, part 4): the requisition and the
 * purchase order are printed as NAV prints its documents, black on white, and
 * the approved PrPdf and PoPdf boards draw both with one style sheet. The
 * boards are drawn in pixels at 96 dpi; a point is three quarters of a pixel.
 */

export const INK = '#111111';
export const MUTED = '#444444';
const RULE = '#bbbbbb';

export const navStyles = StyleSheet.create({
  // No line height on the page itself: @react-pdf then drops the fixed footer and every page number (2026-11-20).
  // The blocks that hold text name theirs.
  page: { paddingTop: 36, paddingBottom: 52, paddingHorizontal: 36, fontSize: 9.5, color: INK, fontFamily: 'Helvetica' },
  /** The office's address and phone under its name. */
  // A line height is measured from the element's own font size (18 pt when it only inherits one), so both are named.
  fromLine: { color: MUTED, fontSize: 9.5, lineHeight: 1.35 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  // Each larger size names its own line height: the page's would otherwise be measured from its 9.5 pt.
  company: { fontSize: 13, fontFamily: 'Helvetica-Bold', lineHeight: 1.25 },
  muted: { color: MUTED },
  bold: { fontFamily: 'Helvetica-Bold' },
  right: { textAlign: 'right' },
  titleBox: { alignItems: 'flex-end' },
  title: { fontSize: 19.5, fontFamily: 'Helvetica-Bold', lineHeight: 1.2 },
  number: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginTop: 1, lineHeight: 1.25 },
  stamp: { marginTop: 3, borderWidth: 1.5, borderColor: INK, paddingTop: 2.5, paddingBottom: 1.5, paddingHorizontal: 6, fontSize: 9, fontFamily: 'Helvetica-Bold', letterSpacing: 0.7, lineHeight: 1 },
  rule: { borderTopWidth: 1.5, borderTopColor: INK, marginTop: 13, marginBottom: 13 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 13 },
  fact: { flexDirection: 'row', paddingRight: 12, paddingVertical: 1.5, fontSize: 9.4, lineHeight: 1.35 },
  factLabel: { width: 92, color: MUTED },
  factValue: { flex: 1, fontFamily: 'Helvetica-Bold' },
  /** A boxed block: an address, the notes to the vendor. */
  box: { borderWidth: 0.75, borderColor: INK, paddingVertical: 7.5, paddingHorizontal: 9, fontSize: 9.4, lineHeight: 1.35 },
  boxHead: { fontSize: 9, fontFamily: 'Helvetica-Bold', textTransform: 'uppercase', letterSpacing: 0.55, marginBottom: 3 },
  head: { flexDirection: 'row', borderTopWidth: 0.75, borderBottomWidth: 0.75, borderColor: INK },
  th: { fontSize: 9, fontFamily: 'Helvetica-Bold', paddingVertical: 4.5, paddingHorizontal: 4.5, lineHeight: 1.35 },
  row: { flexDirection: 'row', borderBottomWidth: 0.75, borderBottomColor: RULE },
  td: { fontSize: 9.4, paddingVertical: 4.5, paddingHorizontal: 4.5, lineHeight: 1.35 },
  totals: { marginLeft: 'auto', width: 240, marginTop: 13 },
  total: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5, fontSize: 9.4, lineHeight: 1.35 },
  grand: { borderTopWidth: 1.5, borderTopColor: INK, marginTop: 3, paddingTop: 4.5, fontSize: 11.25, lineHeight: 1.25 },
  signs: { flexDirection: 'row', marginTop: 13 },
  sign: { flex: 1, borderWidth: 0.75, borderColor: INK, paddingVertical: 7.5, paddingHorizontal: 9, minHeight: 69, fontSize: 9.4, lineHeight: 1.35 },
  /** What a signature box says, kept clear of the line signed on. */
  signText: { marginBottom: 10 },
  signGap: { marginLeft: 13.5 },
  signLine: { marginTop: 'auto', borderTopWidth: 0.75, borderTopColor: INK, paddingTop: 2, fontSize: 9, color: MUTED },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: INK, paddingTop: 4.5, fontSize: 9, color: MUTED },
});

/** "11/24/2026": a day, as NAV prints one, never moved by a time zone. */
export function navDay(day: string | null | undefined) {
  if (!day) return '';
  const [year, month, date] = day.slice(0, 10).split('-');
  return year && month && date ? `${month}/${date}/${year}` : '';
}

const MOMENT = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE });
/** "11/19/2026, 10:42 AM": a moment, in Texas time. */
export const navMoment = (at: string | Date) => MOMENT.format(new Date(at));

const TEXAS_DAY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: BUSINESS_TIME_ZONE });
/** "11/19/2026": the Texas day of a moment. */
export const navMomentDay = (at: string | Date) => navDay(TEXAS_DAY.format(new Date(at)));

const AMOUNT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "1,234.50": dollars without the sign, the currency named in the heading. */
export const navAmount = (cents: number) => AMOUNT.format(cents / 100);

/** "STORE · Office Storeroom", or the name alone when it has no code. */
export const coded = (ref: { code?: string | null; name: string } | null | undefined) => (ref ? (ref.code ? `${ref.code} · ${ref.name}` : ref.name) : '');

/** The office's address on one line, and its phone and email on another. */
export function fromLines(from: { addressLine1: string | null; addressLine2: string | null; phone: string | null; email: string | null }) {
  return {
    address: [from.addressLine1, from.addressLine2].filter(Boolean).join(', '),
    contact: [from.phone, from.email].filter(Boolean).join(' · '),
  };
}
