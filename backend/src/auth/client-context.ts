import type { Request } from 'express';

/**
 * Recorded against each session so a stolen-token investigation has something
 * to work with. Deliberately not used for validation: pinning a session to an
 * address would sign out every technician moving between cellular and site
 * Wi-Fi, which is most of them, most of the day.
 */
export function clientContext(request: Request) {
  const forwarded = request.header('x-forwarded-for');
  return {
    userAgent: request.header('user-agent')?.slice(0, 512),
    // Behind nginx and the tunnel, the socket address is the proxy. The first
    // entry is the original client.
    ipAddress: (forwarded?.split(',')[0]?.trim() || request.ip)?.slice(0, 64),
  };
}
