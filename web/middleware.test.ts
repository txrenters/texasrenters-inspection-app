// @vitest-environment node

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { middleware } from './middleware';

/**
 * The server-side guard in front of the admin shell.
 *
 * It decides only whether a page is worth serving; the API verifies every
 * request. "Remember me" (2026-10-02) added one case: a remembered sign-in
 * whose hour-long access token has run out is let through, for the page to
 * renew under the browser's cross-tab lock, instead of being sent to sign in.
 */

function token(expiresAt: number) {
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', exp: expiresAt })).toString('base64url');
  return `header.${payload}.signature`;
}

const now = () => Math.floor(Date.now() / 1000);

function visit(cookies: string) {
  return middleware(
    new NextRequest('https://inspection.texasrenters.com/map', { headers: cookies ? { cookie: cookies } : {} }),
  );
}

const sentToSignIn = (response: Response) => response.headers.get('location')?.endsWith('/login') ?? false;
const letThrough = (response: Response) => response.headers.get('x-middleware-next') === '1';

describe('the admin shell guard', () => {
  it('lets a live session through', () => {
    expect(letThrough(visit(`tr_access=${token(now() + 600)}`))).toBe(true);
  });

  it('sends a visitor with no session to sign in', () => {
    expect(sentToSignIn(visit(''))).toBe(true);
  });

  it('sends an expired session that was not remembered to sign in', () => {
    expect(sentToSignIn(visit(`tr_access=${token(now() - 60)}`))).toBe(true);
  });

  it('lets a remembered sign-in through when its access token has run out, for the page to renew', () => {
    expect(letThrough(visit(`tr_access=${token(now() - 60)}; tr_remember=1`))).toBe(true);
    // The access cookie is gone altogether once its hour is up.
    expect(letThrough(visit('tr_remember=1'))).toBe(true);
  });
});
