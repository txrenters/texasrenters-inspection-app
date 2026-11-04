import type { InvoiceJobberRead } from '@texasrenters/shared';

/**
 * What an unfiltered, empty Invoices list says (2026-11-05), by where the
 * server's read of Jobber's invoices stands. Each names what to do, since an
 * empty list alone looks the same whatever the cause.
 */
export function noInvoicesYet(read: InvoiceJobberRead | undefined) {
  if (read?.problem === 'NOT_CONNECTED') return 'Connect Jobber, and its invoices are read in here.';
  if (read?.problem === 'NOT_PERMITTED')
    return "Jobber is not letting the console read invoices yet. Add the Invoices read scope to the app in Jobber's Developer Center, then reconnect Jobber.";
  if (read?.problem === 'FAILED') return 'The last read from Jobber failed. It is tried again within the hour.';
  if (read && !read.firstReadDone)
    return "Jobber's invoices are being read for the first time. They appear here over the next few hours.";
  return 'Invoices appear here once Jobber is connected and the first copy has been read.';
}
