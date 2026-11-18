import { MicrosoftError, type MicrosoftAuthService } from './microsoft-auth.service';

/**
 * The Microsoft Graph calls the Actual vs Budget workbook sync makes
 * (2026-11-17), as the connected account. One client is one run of the sync:
 * it counts its calls and refuses past the run's budget, so a run can never
 * make more than MICROSOFT_EXCEL_CALLS_PER_RUN calls; a refused token is
 * renewed once; and when Microsoft says to slow down (429, 503) the run stops
 * and the next one carries on. Microsoft does not bill these calls.
 */

export interface SharedWorkbook {
  driveId: string;
  itemId: string;
  name: string;
  webUrl: string | null;
}

/** A sharing link as Graph's /shares takes it: "u!" and the link in unpadded base64url. */
export const encodeSharingUrl = (url: string) => `u!${Buffer.from(url.trim(), 'utf8').toString('base64url')}`;

export class ExcelGraphClient {
  private calls = 0;
  private sessionId: string | null = null;
  /** A session is wanted for the run's writes: opened at its first write, so a run that only reads opens none. */
  private sessionWanted = false;

  constructor(
    private readonly auth: MicrosoftAuthService,
    private readonly organizationId: string,
    private readonly workbook: { driveId: string; itemId: string } | null = null,
  ) {}

  get callsMade() {
    return this.calls;
  }

  /** Whose account is connected. */
  async me(): Promise<{ name: string | null; email: string | null }> {
    const me = await this.call<{ displayName?: string; mail?: string; userPrincipalName?: string }>('GET', '/me?$select=displayName,mail,userPrincipalName');
    return { name: me.displayName ?? null, email: me.mail ?? me.userPrincipalName ?? null };
  }

  /** The workbook a sharing link names -- if this account may open it. */
  async resolveShare(url: string): Promise<SharedWorkbook> {
    const item = await this.call<{ id: string; name: string; webUrl?: string; file?: unknown; parentReference?: { driveId?: string } }>(
      'GET',
      `/shares/${encodeSharingUrl(url)}/driveItem?$select=id,name,webUrl,file,parentReference`,
      undefined,
      { prefer: 'redeemSharingLinkIfNecessary' },
    );
    if (!item.file || !item.parentReference?.driveId) throw new MicrosoftError('That link is not a file.', 'EXCEL_NOT_A_FILE', 422);
    if (!/\.xlsx$/i.test(item.name)) throw new MicrosoftError('That link is not an Excel workbook (.xlsx).', 'EXCEL_NOT_A_WORKBOOK', 422);
    return { driveId: item.parentReference.driveId, itemId: item.id, name: item.name, webUrl: item.webUrl ?? null };
  }

  async worksheetNames(): Promise<string[]> {
    const answer = await this.call<{ value: { name: string }[] }>('GET', `${this.book()}/worksheets?$select=name`);
    return answer.value.map((sheet) => sheet.name);
  }

  /**
   * The workbook's content version (cTag): it changes whenever anyone edits a
   * cell, the console included. Compared with the one kept after the console's
   * last write, it says whether the office has edited the workbook since.
   */
  async fileTag(): Promise<string | null> {
    if (!this.workbook) throw new MicrosoftError('No workbook is linked.', 'EXCEL_NOT_LINKED', 409);
    const item = await this.call<{ cTag?: string; eTag?: string }>(
      'GET',
      `/drives/${encodeURIComponent(this.workbook.driveId)}/items/${encodeURIComponent(this.workbook.itemId)}?$select=cTag,eTag`,
    );
    return item.cTag ?? item.eTag ?? null;
  }

  /**
   * A range's cells: as Excel shows them ("$400", "8h 25m", a remark), what
   * each holds (400, 0.35, the remark) -- and, in the same call, each one's
   * formula ("=SUM(G12:G14)", or what it holds when it has none) and format.
   */
  async readCells(
    sheet: string,
    address: string,
  ): Promise<{ text: string[][]; values: (string | number | boolean | null)[][]; formulas: unknown[][]; numberFormat: string[][] }> {
    const range = await this.call<{ text?: unknown[][]; values?: unknown[][]; formulas?: unknown[][]; numberFormat?: unknown[][] }>(
      'GET',
      `${this.range(sheet, address)}?$select=text,values,formulas,numberFormat`,
    );
    return {
      text: (range.text ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))),
      values: (range.values ?? []).map((row) =>
        row.map((cell) => (typeof cell === 'number' || typeof cell === 'string' || typeof cell === 'boolean' ? cell : null)),
      ),
      formulas: range.formulas ?? [],
      numberFormat: (range.numberFormat ?? []).map((row) => row.map((cell) => (typeof cell === 'string' ? cell : 'General'))),
    };
  }

  /** Each cell's format, nothing else: what the cells hold stays as it is. */
  async setNumberFormat(sheet: string, address: string, numberFormat: string[][]) {
    await this.call('PATCH', `${this.range(sheet, address)}`, { numberFormat });
  }

  /** A formula entered as the office would type it, for Excel to work out. */
  async writeFormulas(sheet: string, address: string, formulas: string[][]) {
    await this.call('PATCH', `${this.range(sheet, address)}`, { formulas });
  }

  /** The last row anything is typed in on a tab (1-based); 0 for an empty tab. */
  async lastUsedRow(sheet: string): Promise<number> {
    const used = await this.call<{ address?: string }>('GET', `${this.book()}/worksheets/${encodeURIComponent(sheet)}/usedRange(valuesOnly=true)?$select=address`);
    const last = /(\d+)$/.exec(used.address ?? '')?.[1];
    return last ? Number(last) : 0;
  }

  /** A row's fill, as the office fills its Total rows; null takes it off. */
  async fill(sheet: string, address: string, color: string | null) {
    if (color) await this.call('PATCH', `${this.range(sheet, address)}/format/fill`, { color });
    else await this.call('POST', `${this.range(sheet, address)}/format/fill/clear`, {});
  }

  async addWorksheet(name: string) {
    await this.call('POST', `${this.book()}/worksheets/add`, { name });
  }

  /** Values, and the format each cell shows them in (`formatOf`). */
  async writeRange(sheet: string, address: string, values: (string | number)[][], numberFormat?: string[][]) {
    await this.call('PATCH', `${this.range(sheet, address)}`, numberFormat ? { values, numberFormat } : { values });
  }

  /** Empty a range: its contents, or ('All') its look too -- a taken-over log tab's fills and borders. */
  async clearRange(sheet: string, address: string, applyTo: 'Contents' | 'All' = 'Contents') {
    await this.call('POST', `${this.range(sheet, address)}/clear`, { applyTo });
  }

  async bold(sheet: string, address: string, bold: boolean) {
    await this.call('PATCH', `${this.range(sheet, address)}/format/font`, { bold });
  }

  async autofitColumns(sheet: string, address: string) {
    await this.call('POST', `${this.range(sheet, address)}/format/autofitColumns`, {});
  }

  /**
   * One workbook session for a run's writes, as Microsoft recommends; without
   * one, every call still works. Opened at the run's first write, not here
   * (2026-11-18): a run that only reads the office's edits is only reads, and
   * holds the workbook in no session of its own while the office types.
   */
  async openSession() {
    this.sessionWanted = true;
  }

  private async startSession() {
    this.sessionWanted = false;
    try {
      const session = await this.call<{ id: string }>('POST', `${this.book()}/createSession`, { persistChanges: true });
      this.sessionId = session.id;
    } catch (error) {
      if (error instanceof MicrosoftError && error.code === 'MICROSOFT_RATE_LIMITED') throw error;
      this.sessionId = null;
    }
  }

  async closeSession() {
    this.sessionWanted = false;
    if (!this.sessionId) return;
    const id = this.sessionId;
    try {
      await this.call('POST', `${this.book()}/closeSession`, {});
    } catch {
      // A session Microsoft already let go of is gone either way.
    }
    if (this.sessionId === id) this.sessionId = null;
  }

  private book() {
    if (!this.workbook) throw new MicrosoftError('No workbook is linked.', 'EXCEL_NOT_LINKED', 409);
    return `/drives/${encodeURIComponent(this.workbook.driveId)}/items/${encodeURIComponent(this.workbook.itemId)}/workbook`;
  }

  private range(sheet: string, address: string) {
    return `${this.book()}/worksheets/${encodeURIComponent(sheet)}/range(address='${address}')`;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, options: { prefer?: string } = {}, retried = false): Promise<T> {
    // The run's first write opens its session.
    if (this.sessionWanted && method !== 'GET' && !retried && !/\/(createSession|closeSession)$/.test(path)) await this.startSession();
    const config = this.auth.config();
    if (this.calls >= config.callsPerRun) throw new MicrosoftError('This run has made all the calls it may; the next one carries on.', 'EXCEL_RUN_BUDGET_SPENT', 429);
    this.calls += 1;
    const token = retried ? await this.auth.refresh(this.organizationId) : await this.auth.accessToken(this.organizationId);
    let response: Response;
    try {
      response = await fetch(`${config.graphBaseUrl}/v1.0${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.sessionId ? { 'workbook-session-id': this.sessionId } : {}),
          ...(options.prefer ? { prefer: options.prefer } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch {
      throw new MicrosoftError('Microsoft could not be reached. The next run tries again.', 'MICROSOFT_UNREACHABLE', 502);
    }
    if (response.status === 401 && !retried) return this.call<T>(method, path, body, options, true);
    if (response.status === 429 || response.status === 503) {
      const after = response.headers.get('retry-after');
      throw new MicrosoftError(`Microsoft asked to slow down${after ? ` for ${after} s` : ''}. The next run carries on.`, 'MICROSOFT_RATE_LIMITED', 429, response.status);
    }
    if (response.status === 403 || response.status === 404) {
      throw new MicrosoftError(
        response.status === 404
          ? 'Microsoft could not find the workbook or the tab. Check the link, and that the connected account can open the file.'
          : 'The connected Microsoft account may not edit the workbook. Share it with that account as "Can edit".',
        response.status === 404 ? 'EXCEL_NOT_FOUND' : 'EXCEL_FORBIDDEN',
        response.status === 404 ? 404 : 403,
        response.status,
      );
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new MicrosoftError(`Microsoft refused a workbook change: ${detail?.error?.message ?? response.status}`.slice(0, 300), 'EXCEL_REFUSED', 502, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => undefined)) as T;
  }
}
