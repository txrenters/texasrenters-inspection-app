#!/usr/bin/env node

/**
 * Starts Metro behind the Cloudflare Tunnel.
 *
 * Two hostnames now, where ngrok had one:
 *   CLOUDFLARE_TUNNEL_HOSTNAME -> NestJS   (the REST API and websockets)
 *   CLOUDFLARE_METRO_HOSTNAME  -> Metro    (manifest, bundle, Fast Refresh)
 *
 * That split is the whole reason this file changed. Under ngrok both concerns
 * shared a URL and the nginx gateway separated them by path, so this script set
 * EXPO_PUBLIC_API_BASE_URL and EXPO_PACKAGER_PROXY_URL to the *same* value.
 * Doing that now would serve the bundle from the API host, whose catch-all is a
 * 404 — Expo Go would fail to download the app with nothing to explain why.
 *
 * The hostnames are read rather than discovered. A token-based Cloudflare
 * tunnel is never told what it is published as, so there is no equivalent of
 * ngrok's agent API to ask.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BACKEND_ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env.local');

function fail(message) {
  console.error(`\nUnable to start the TexasRenters mobile tunnel:\n${message}\n`);
  process.exit(1);
}

/** Reads a value from backend/.env.local, which is where tunnel config lives. */
function readBackendEnv(name) {
  try {
    const raw = readFileSync(BACKEND_ENV, 'utf8').replace(/^﻿/, '');
    return raw.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Accepts a bare hostname or a full URL, and always returns an https origin. */
function originFor(value) {
  return `https://${value.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

function resolveHostnames() {
  const api = process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim() || readBackendEnv('CLOUDFLARE_TUNNEL_HOSTNAME');
  const metro = process.env.CLOUDFLARE_METRO_HOSTNAME?.trim() || readBackendEnv('CLOUDFLARE_METRO_HOSTNAME');

  if (!api)
    fail(
      'CLOUDFLARE_TUNNEL_HOSTNAME is not set in backend/.env.local.\n' +
        'It is the public hostname routed to http://backend:3000.',
    );
  if (!metro)
    fail(
      'CLOUDFLARE_METRO_HOSTNAME is not set in backend/.env.local.\n' +
        'Add a public hostname in Zero Trust → Networks → Tunnels → Public Hostnames\n' +
        '  pointing at http://host.docker.internal:8082, then set it here.\n' +
        '\n' +
        'It must NOT be the same host as the API: that host answers 404 for every\n' +
        'path Metro needs, so Expo Go would fail to fetch the bundle.',
    );
  if (originFor(api) === originFor(metro))
    fail(
      `CLOUDFLARE_TUNNEL_HOSTNAME and CLOUDFLARE_METRO_HOSTNAME are both ${originFor(api)}.\n` +
        'They route to different services and cannot be the same hostname.',
    );

  return { api: originFor(api), metro: originFor(metro) };
}

/**
 * Statuses that mean "not ready yet" rather than "the API said no".
 *
 * 404 is what Cloudflare serves for a hostname whose tunnel has not finished
 * binding, which a freshly restarted stack does for a few seconds.
 */
const TRANSIENT_HTTP_STATUSES = new Set([404, 429, 502, 503, 504]);

/** Why a fetch failed, in the terms the person reading it can act on. */
function describeFetchFailure(error) {
  if (error?.name === 'TimeoutError') return 'timed out';
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS lookup failed';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code) return code;
  return error?.message ?? 'unknown error';
}

/**
 * Confirms the tunnel actually reaches the API before handing over to Metro.
 *
 * Retried rather than judged on one attempt. The first request through a cold
 * tunnel routinely takes several seconds — TLS plus the connector's first
 * upstream connection — and a single 10s timeout turned that ordinary warm-up
 * into "the tunnel is unreachable", sending people to debug infrastructure that
 * was working.
 *
 * The reason is reported too. This used to `catch {}` without binding the
 * error, so a timeout, a DNS failure and a refused connection all printed the
 * same sentence and none of them said which.
 */
async function verifyBackend(publicUrl) {
  const healthUrl = new URL('/api/v1/health', publicUrl);
  const attempts = 3;
  let lastReason = 'unknown error';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      // Some non-OK statuses are the edge still warming up rather than the API
      // objecting. Cloudflare answers 404 for a hostname whose tunnel has not
      // finished binding, and 502/503 while the connector is reconnecting to a
      // backend that is still coming back after a restart — both clear within
      // seconds and both used to fail the command outright. A status outside
      // this set means something the API itself decided, which retrying only
      // delays.
      lastReason = `HTTP ${response.status}`;
      if (!TRANSIENT_HTTP_STATUSES.has(response.status))
        fail(`The public backend health check returned HTTP ${response.status} at ${healthUrl}.`);
    } catch (error) {
      lastReason = describeFetchFailure(error);
      if (attempt < attempts) {
        console.warn(
          `  Health check attempt ${attempt}/${attempts} failed (${lastReason}); retrying…`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }

  // The hostname resolves to several Cloudflare edge addresses and Node's fetch picks
  // one without failing over, so a single slow edge can time out repeatedly
  // from this machine while the tunnel serves the phone perfectly well. If the
  // backend answers locally, that is what this check was really asking about —
  // warn with the reason and let Metro start rather than blocking on an edge
  // the device may never touch.
  const localHealthy = await backendRespondsLocally();
  if (localHealthy) {
    // A 502 and a timeout look alike in the summary and mean opposite things.
    //
    // A timeout is the edge being slow, and the device may well be fine. A 502
    // is the edge answering promptly to say the connector could not reach the
    // backend — nothing about that improves by waiting, and the device will
    // fail exactly the same way. Calling both "most likely a slow edge" sent
    // people to restart a tunnel that was working.
    const originUnreachable = lastReason === 'HTTP 502' || lastReason === 'HTTP 503';
    console.warn(
      `\n  Warning: ${healthUrl} did not respond from this machine after ` +
        `${attempts} attempts (${lastReason}).\n` +
        (originUnreachable
          ? '  The backend is healthy on http://127.0.0.1:3000, so the request reached\n' +
            '  Cloudflare and the connector could not reach the backend container. Check\n' +
            '  that the published hostname still names http://backend:3000, and that the\n' +
            '  connector is up. The device will fail the same way until it is.\n\n' +
            '    docker logs texasrenters-tunnel-1 --tail 20\n' +
            '    curl http://127.0.0.1:2000/ready\n'
          : '  The backend is healthy on http://127.0.0.1:3000, so this is most likely a\n' +
            '  slow edge rather than a broken tunnel — the device may reach it fine.\n' +
            '  Starting Metro anyway. If the device cannot reach the API, restart:\n' +
            '    npm run remote-beta:stop && npm run remote-beta\n'),
    );
    return;
  }

  fail(
    `The public backend tunnel is registered but ${healthUrl} did not respond ` +
      `after ${attempts} attempts (${lastReason}),\n` +
      'and the backend is not answering on http://127.0.0.1:3000 either.\n' +
      'Check the containers:\n' +
      '  npm run remote-beta:status',
  );
}

/** Is the API up at all, independently of the tunnel? */
async function backendRespondsLocally() {
  try {
    const response = await fetch('http://127.0.0.1:3000/api/v1/health', {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const { api: publicApiUrl, metro: publicMetroUrl } = resolveHostnames();
await verifyBackend(publicApiUrl);

console.log('TexasRenters tunnel routing verified:');
console.log(`  REST API  : ${publicApiUrl}/api/v1/*  -> Docker backend`);
console.log(`  Metro     : ${publicMetroUrl}          -> host port 8082`);
const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  console.log('  Metro     : configuration check only; not started');
} else {

  const extraArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== '--' && argument !== '--check');
  const expoCli = require.resolve('expo/bin/cli');
  const child = spawn(
    process.execPath,
    [expoCli, 'start', '--lan', '--go', '--port', '8082', ...extraArgs],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'remote-beta',
        // Where the app sends its API calls: the backend hostname.
        EXPO_PUBLIC_API_BASE_URL: publicApiUrl,
        // Where the app is downloaded from: the Metro hostname. Expo officially
        // supports this override; it rewrites the manifest and QR address
        // without launching Expo's own tunnel agent.
        //
        // These were the same variable's value until the hostnames split. They
        // are different services and must stay different here.
        EXPO_PACKAGER_PROXY_URL: publicMetroUrl,
      },
      stdio: 'inherit',
    },
  );

  child.on('error', (error) => fail(`Expo could not be started: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}
