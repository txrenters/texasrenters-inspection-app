import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The proxy must accept anything the application is willing to accept.
 *
 * `sites.caddy` has always said this in a comment — the limit sits just above
 * the largest upload so an oversized file is refused by the application, with
 * its own message, rather than by the proxy with a bare 413. Then the report
 * import raised its own limit to 150 MB and left the proxy at 25 MB, and every
 * real report was refused at the edge.
 *
 * That failure is worse than a 413, because Caddy rejects an oversized body
 * *before* proxying: the response carries none of the backend's CORS headers,
 * so the browser reports "No 'Access-Control-Allow-Origin' header is present"
 * and sends you to read CORS configuration that was never wrong.
 *
 * A comment could not hold the invariant. This can.
 */

const repoRoot = join(__dirname, '..', '..');

const caddyLimitBytes = () => {
  const config = readFileSync(join(repoRoot, 'docker', 'proxy', 'sites.caddy'), 'utf8');
  const match = config.match(/max_size\s+(\d+)(KB|MB|GB)/i);
  if (!match) throw new Error('No `request_body max_size` found in sites.caddy');
  const scale = { KB: 1_000, MB: 1_000_000, GB: 1_000_000_000 }[match[2]!.toUpperCase()]!;
  return Number(match[1]) * scale;
};

/** Every `fileSize` an upload route accepts, in bytes. */
const appLimits = () => {
  const controllers = ['admin/admin.controller.ts', 'technician/technician.controller.ts'];
  const limits: Array<{ file: string; bytes: number }> = [];
  for (const relative of controllers) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, 'backend', 'src', relative), 'utf8');
    } catch {
      continue; // A controller that does not exist has no upload routes.
    }
    for (const match of source.matchAll(/fileSize:\s*([\d_]+)/g))
      limits.push({ file: relative, bytes: Number(match[1]!.replaceAll('_', '')) });
  }
  return limits;
};

/**
 * Room video, which never reaches this proxy.
 *
 * Recordings upload from the handset straight to Cloudflare Stream, which is
 * why `sites.caddy` says the limit does not cover them and why two gigabytes
 * does not have to fit under it. Exempted by its size rather than its route
 * because the limits are read out of source; if a second two-gigabyte upload
 * appears that *does* traverse the proxy, this exemption will hide it, and the
 * comment is here so the next person knows to check.
 */
const VIDEO_BYPASS_BYTES = 2_000_000_000;

describe('the proxy body limit', () => {
  it('is above every upload that actually traverses it', () => {
    const proxy = caddyLimitBytes();
    const proxied = appLimits().filter((limit) => limit.bytes !== VIDEO_BYPASS_BYTES);

    expect(proxied.length).toBeGreaterThan(0);
    const largest = proxied.reduce((max, limit) => (limit.bytes > max.bytes ? limit : max));
    // Strictly above, not equal: a file exactly on the boundary should reach
    // the application, and multipart framing adds a little to the body anyway.
    expect(proxy).toBeGreaterThan(largest.bytes);
  });

  it('covers the handset photo route, which was already over the old limit', () => {
    // Found by writing this test rather than by anything failing: photos accept
    // 30 MB and the proxy allowed 25 MB, so a large one was refused at the edge
    // with a bare 413 long before the report import existed. Real photographs
    // are far smaller, which is why nobody hit it.
    expect(caddyLimitBytes()).toBeGreaterThan(30_000_000);
  });

  it('leaves room for the report import in particular', () => {
    // The route this was broken for. Named explicitly so a future change that
    // lowers the proxy limit fails with the reason rather than an arithmetic
    // comparison nobody can place.
    const reportImport = 150_000_000;
    expect(appLimits().some((limit) => limit.bytes === reportImport)).toBe(true);
    expect(caddyLimitBytes()).toBeGreaterThan(reportImport);
  });
});
