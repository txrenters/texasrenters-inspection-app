#!/usr/bin/env node

/**
 * Starts V2 Metro behind the Docker-managed remote-beta gateway.
 *
 * One ngrok domain serves both concerns without creating a second agent:
 *   /api/* and /socket.io/* -> NestJS
 *   every other path        -> Metro on host port 8082
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const NGROK_AGENT_API =
  process.env.TEXASRENTERS_NGROK_AGENT_API?.trim() || 'http://127.0.0.1:4041/api/tunnels';

function fail(message) {
  console.error(`\nUnable to start the TexasRenters mobile tunnel:\n${message}\n`);
  process.exit(1);
}

async function discoverBackendUrl() {
  let response;
  try {
    response = await fetch(NGROK_AGENT_API, { signal: AbortSignal.timeout(5_000) });
  } catch {
    fail(
      `The Docker ngrok agent is not reachable at ${NGROK_AGENT_API}.\n` +
        'Run pnpm remote-beta first, then retry pnpm start:tunnel.',
    );
  }
  if (!response.ok) fail(`The Docker ngrok agent returned HTTP ${response.status}.`);

  const payload = await response.json();
  const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
  const tunnel =
    tunnels.find(
      (candidate) =>
        candidate?.proto === 'https' &&
        typeof candidate?.public_url === 'string' &&
        String(candidate?.config?.addr ?? '').includes('gateway'),
    ) ??
    tunnels.find(
      (candidate) => candidate?.proto === 'https' && typeof candidate?.public_url === 'string',
    );
  if (!tunnel) fail('No HTTPS backend tunnel is registered. Check the Docker tunnel service logs.');

  const upstream = String(tunnel?.config?.addr ?? '');
  if (!upstream.includes('gateway')) {
    fail(
      `The live ngrok tunnel still points to "${upstream || 'an unknown upstream'}" instead of ` +
        'the remote-beta gateway.\nRun pnpm remote-beta once from the repository root to ' +
        'recreate the Docker stack with the current configuration.',
    );
  }

  return new URL(tunnel.public_url).origin;
}

/**
 * Statuses that mean "not ready yet" rather than "the API said no".
 *
 * 404 is ngrok's answer for a domain whose tunnel has not finished binding —
 * which is exactly what a freshly restarted stack serves for a few seconds.
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
 * ngrok tunnel routinely takes several seconds — TLS plus the agent's first
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
        headers: { 'ngrok-skip-browser-warning': 'true' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      // Some non-OK statuses are the edge still warming up rather than the API
      // objecting. ngrok answers 404 for a domain whose tunnel has not finished
      // binding, and the gateway answers 502/503 while its upstream is coming
      // back after a restart — both clear within seconds and both used to fail
      // the command outright. A status outside this set means something the API
      // itself decided, which retrying only delays.
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

  // The tunnel resolves to several ngrok edge addresses and Node's fetch picks
  // one without failing over, so a single slow edge can time out repeatedly
  // from this machine while the tunnel serves the phone perfectly well. If the
  // backend answers locally, that is what this check was really asking about —
  // warn with the reason and let Metro start rather than blocking on an edge
  // the device may never touch.
  const localHealthy = await backendRespondsLocally();
  if (localHealthy) {
    console.warn(
      `\n  Warning: ${healthUrl} did not respond from this machine after ` +
        `${attempts} attempts (${lastReason}).\n` +
        '  The backend is healthy on http://127.0.0.1:3000, so this is most likely a slow\n' +
        '  ngrok edge rather than a broken tunnel. Starting Metro anyway — if the device\n' +
        '  cannot reach the API, restart the gateway:\n' +
        '    pnpm remote-beta:stop && pnpm remote-beta\n',
    );
    return;
  }

  fail(
    `The public backend tunnel is registered but ${healthUrl} did not respond ` +
      `after ${attempts} attempts (${lastReason}),\n` +
      'and the backend is not answering on http://127.0.0.1:3000 either.\n' +
      'Check the containers:\n' +
      '  pnpm remote-beta:status',
  );
}

/** Is the API up at all, independently of ngrok? */
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

const publicApiUrl = await discoverBackendUrl();
await verifyBackend(publicApiUrl);

console.log('TexasRenters tunnel routing verified:');
console.log(`  Public URL: ${publicApiUrl}`);
console.log('  REST API  : /api/v1/* -> Docker backend');
const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  console.log('  Metro     : configuration check only; not started');
} else {
  console.log('  Metro     : V2 on port 8082 through the same ngrok URL');

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
        EXPO_PUBLIC_API_BASE_URL: publicApiUrl,
        // Expo officially supports this override. It changes the manifest/QR
        // address without launching Expo's own @expo/ngrok agent.
        EXPO_PACKAGER_PROXY_URL: publicApiUrl,
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
