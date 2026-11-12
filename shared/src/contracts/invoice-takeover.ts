/**
 * Taking invoicing over from Jobber (2026-11-06, phase 8, the cutover).
 *
 * Until then Jobber holds the invoices and payments, and the console reads
 * them. At the cutover the console reads Jobber one last time, stops reading
 * it -- a read would overwrite what the office now changes here -- and makes
 * and changes invoices and payments itself. Nothing is ever sent to Jobber.
 *
 * Ready once every invoice and payment has been read, Jobber answers, and
 * every file is kept (or the office says the ones that could not be copied can
 * be left). Undone only while nothing has been changed in the console since:
 * after that, reading Jobber again would overwrite the office's work.
 */

export type InvoiceTakeoverCheckKey =
  | 'JOBBER_ANSWERS'
  | 'INVOICES_READ'
  | 'PAYMENTS_READ'
  | 'FILES_COPIED'
  | 'FILES_FAILED'
  | 'COMPANY_DETAILS'
  /**
   * Each product the office offers goes to a company that sends to Xero
   * (2026-11-13): else its invoices would get the console's own numbers and
   * reach no books.
   */
  | 'PRODUCTS_GO_TO_XERO'
  /** Each company that sends to Xero has its books read back from there (2026-11-12). */
  | 'XERO_BOOKS_READ';

export interface InvoiceTakeoverCheck {
  key: InvoiceTakeoverCheckKey;
  ok: boolean;
  /** Not ok holds the cutover back; otherwise it is something to know. */
  blocking: boolean;
  label: string;
  detail: string | null;
}

export interface InvoiceTakeoverView {
  /** ISO; null while Jobber holds the invoices. */
  takenOverAt: string | null;
  takenOverBy: { id: string; displayName: string } | null;
  /** Invoice and payment changes made in the console since it was taken over. */
  changesSince: number;
  /** Taken over, with nothing changed since: it can still be undone. */
  undoable: boolean;
  /** Before the cutover: what it waits on. Empty once taken over. */
  checks: InvoiceTakeoverCheck[];
  /** Every check that holds the cutover back passes. */
  ready: boolean;
  /** Files that could not be copied: the office says they can be left before taking over. */
  failedFiles: number;
  /**
   * Jobber is connected (2026-11-12): it is read one last time before the
   * switch. Not connected, its checks are only something to know, and the
   * switch is made without it.
   */
  jobberConnected?: boolean;
}

export interface TakeOverInvoicingInput {
  /** The files that could not be copied can be left: they open from Jobber only while it lasts. */
  acceptFailedFiles?: boolean;
}

/** Who may take invoicing over, or undo it: whoever makes invoices and runs the integrations. */
export const INVOICE_TAKEOVER_PERMISSIONS = ['invoices:manage', 'integrations:manage'] as const;
