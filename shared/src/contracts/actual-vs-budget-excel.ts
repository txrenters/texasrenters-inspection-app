/**
 * Actual vs Budget kept in step with the office's own workbook (2026-11-17;
 * the office: "everything should sync on this spreadsheet also").
 */

export type MicrosoftConnectionStatus = 'CONNECTED' | 'REAUTHORIZATION_REQUIRED' | 'DISCONNECTED';

export interface ExcelSyncView {
  /** Whether this server has the Microsoft app's settings at all. */
  configured: boolean;
  /** The address Microsoft must have on the app as a redirect URI. */
  redirectUri: string | null;
  connection: {
    status: MicrosoftConnectionStatus;
    accountEmail: string | null;
    accountName: string | null;
    connectedAt: string | null;
    problem: string | null;
  } | null;
  workbook: {
    shareUrl: string;
    fileName: string;
    webUrl: string | null;
    enabled: boolean;
    /** The first day the console writes; the tabs before it are the office's own. */
    startDate: string;
    lastPushedAt: string | null;
    /** The last time the office's Excel edits were read, and what came of them; null before any was read. */
    lastPull: ExcelPull | null;
    /** A save the workbook has not had yet. */
    waiting: boolean;
    problem: string | null;
  } | null;
}

export interface SaveExcelSyncInput {
  shareUrl?: string;
  startDate?: string;
  enabled?: boolean;
}

/** What one write did; and, when the workbook had been edited since the last, what was read from it first. */
export interface ExcelSyncRun {
  tabs: { name: string; created: boolean; rowsWritten: number }[];
  calls: number;
  pulled: ExcelPull | null;
}

/**
 * "Fix formulas in Excel" (2026-11-18): the Text format the console once gave
 * the cells it wrote -- where a typed formula stays as words -- put right.
 */
export interface ExcelFormulaRepair {
  /** Tabs put right. */
  tabs: number;
  /** Cells made General: what they hold is as it was, and a formula typed there now works. */
  cells: number;
  /** Formulas typed into a Text cell, kept as words, entered again for Excel to work out. */
  formulas: number;
  /** Tabs still to do: the next press, or the next run, carries on. */
  waiting: number;
}

/**
 * Reading the office's Excel edits back (2026-11-18, "Both ways" -- and "the
 * spreadsheet will be the source of truth"): cells the office types in on the
 * page come into the console; any other cell it changed is left as it is,
 * the office's; a cell changed in both places takes Excel's value.
 */
export interface ExcelPull {
  at: string;
  taken: number;
  /** Cells written back over the office's (before v2.5.252): none since. */
  putBack: number;
  conflicts: number;
  /** Cells the office changed that the console leaves as they are in Excel, never to write over. */
  kept?: number;
}
