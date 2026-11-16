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

  async addWorksheet(name: string) {
    await this.call('POST', `${this.book()}/worksheets/add`, { name });
  }

  async writeRange(sheet: string, address: string, values: string[][]) {
    await this.call('PATCH', `${this.range(sheet, address)}`, { values });
  }

  async clearRange(sheet: string, address: string) {
    await this.call('POST', `${this.range(sheet, address)}/clear`, { applyTo: 'Contents' });
  }

  async bold(sheet: string, address: string, bold: boolean) {
    await this.call('PATCH', `${this.range(sheet, address)}/format/font`, { bold });
  }

  async autofitColumns(sheet: string, address: string) {
    await this.call('POST', `${this.range(sheet, address)}/format/autofitColumns`, {});
  }

  /** One workbook session for a run's writes, as Microsoft recommends; without one, every call still works. */
  async openSession() {
    try {
      const session = await this.call<{ id: string }>('POST', `${this.book()}/createSession`, { persistChanges: true });
      this.sessionId = session.id;
    } catch (error) {
      if (error instanceof MicrosoftError && error.code === 'MICROSOFT_RATE_LIMITED') throw error;
      this.sessionId = null;
    }
  }

  async closeSession() {
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
