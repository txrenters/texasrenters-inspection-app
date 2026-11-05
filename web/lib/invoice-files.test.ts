import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openInvoiceFile } from './invoice-files';

/**
 * Opening an invoice's file (2026-11-06, phase 7): the tab is opened on the
 * click, before the link is asked for, so no pop-up blocker takes it; it goes
 * to the link the console answers with, and is closed if none comes back.
 */

const api = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => api);

type FakeTab = { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };
let tab: FakeTab | null;

beforeEach(() => {
  tab = { opener: window, location: { href: '' }, close: vi.fn() };
  vi.spyOn(window, 'open').mockImplementation(() => tab as unknown as Window);
});
afterEach(() => vi.restoreAllMocks());

describe('opening a file', () => {
  it('opens the tab first, then sends it to the link, cut off from the console', async () => {
    api.api.mockResolvedValue({ url: 'https://storage.example.com/signed', kept: true });
    expect(await openInvoiceFile('inv-1', 'file-1')).toBe('opened');
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(api.api).toHaveBeenCalledWith('/api/v1/admin/invoices/inv-1/files/file-1/link');
    expect(tab!.location.href).toBe('https://storage.example.com/signed');
    expect(tab!.opener).toBeNull();
  });

  it('closes the tab when no link comes back, and says when the browser opened none', async () => {
    api.api.mockRejectedValue(new Error('This file has not been copied from Jobber yet.'));
    await expect(openInvoiceFile('inv-1', 'file-1')).rejects.toThrow('not been copied');
    expect(tab!.close).toHaveBeenCalled();

    tab = null;
    api.api.mockResolvedValue({ url: 'https://storage.example.com/signed', kept: true });
    expect(await openInvoiceFile('inv-1', 'file-1')).toBe('blocked');
  });
});
