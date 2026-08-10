#!/usr/bin/env node
/**
 * Cold-starts the temporary remote beta and launches mobile.
 *
 * A Cloudflare Tunnel replaces the ngrok agent that used to sit here. The
 * reason is availability: the free ngrok session drops and takes the beta with
 * it, while cloudflared holds four redundant edge connections and rebuilds them
 * itself.
 *
 * Routing moved with it. A token-based tunnel takes its hostnames from the
 * Cloudflare dashboard, so this script can no longer discover the public URL —
 * it reads CLOUDFLARE_TUNNEL_HOSTNAME, and treats an absent one as "the routes
 * have not been added yet" rather than a failure.
 *
 * The gateway still path-routes one hostname when that is what is published:
 *   /api/* and /socket.io/* -> backend container
 *   every other path        -> Metro on host port 8082
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILES = [
  '-f',
  join(ROOT, 'compose.yaml'),
  '-f',
  join(ROOT, 'compose.remote-beta.yaml'),
];
const ENV_FILE = join(ROOT, 'backend', '.env.local');
// The web image inlines NEXT_PUBLIC_* at build time, and interpolation only
// reads --env-file and the root .env — never a service's env_file.
const WEB_ENV_FILE = join(ROOT, 'web-app', '.env.local');
const MOBILE_ENV = join(ROOT, 'mobile', '.env.local');
const TUNNEL_READY_URL = 'http://127.0.0.1:2000/ready';
const PNPM_CLI = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js');

const log = (message) => console.log(message);
const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function readEnvValue(name) {
  const raw = readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, '');
  const match = raw.match(new RegExp(`^${name}=(.+)$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

async function waitForDocker(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (run('docker', ['info']).status === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

async function preflight() {
  if (run('docker', ['--version']).status !== 0)
    fail('Docker CLI is unavailable. Install or start Docker Desktop and retry.');
  if (run('docker', ['compose', 'version']).status !== 0) fail('Docker Compose v2 is unavailable.');
  if (!existsSync(ENV_FILE)) fail(`Missing ${ENV_FILE}.`);

  log('▸ Waiting for Docker Desktop…');
  if (!(await waitForDocker()))
    fail('Docker Desktop did not become ready within 60 seconds. Start it and retry.');

  if (!readEnvValue('CLOUDFLARE_TUNNEL_TOKEN'))
    fail(
      'CLOUDFLARE_TUNNEL_TOKEN is missing from backend/.env.local.\n' +
        '  Zero Trust → Networks → Tunnels → your tunnel → Install connector,\n' +
        '  and copy the token out of the shown command.',
    );

  log('✓ Docker, Compose, and the Cloudflare tunnel token are available');
}

const compose = (...args) =>
  run('docker', ['compose', '--env-file', ENV_FILE, '--env-file', WEB_ENV_FILE, ...COMPOSE_FILES, ...args], {
    stdio: 'inherit',
  });

function readServiceHealth() {
  const result = run('docker', [
    'compose',
    '--env-file',
    ENV_FILE,
    '--env-file',
    WEB_ENV_FILE,
    ...COMPOSE_FILES,
    'ps',
    '--format',
    'json',
  ]);
  const text = (result.stdout ?? '').trim();
  if (!text) return new Map();

  try {
    const rows = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    return new Map(rows.map((row) => [row.Service, (row.Health || '').toLowerCase()]));
  } catch {
    return new Map();
  }
}

async function waitForBackendHealthy(timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = readServiceHealth().get('backend');
    if (health === 'healthy') return true;
    if (health === 'unhealthy')
      fail(
        'Backend container is unhealthy. Inspect it with:\n' +
          '  docker compose --env-file backend/.env.local -f compose.yaml -f compose.remote-beta.yaml logs backend',
      );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

/**
 * Waits for cloudflared to register at least one edge connection.
 *
 * There is no equivalent of ngrok's tunnel-listing API: a token-based tunnel
 * gets its hostnames from the Cloudflare dashboard, so the agent does not know
 * what it is published as and cannot be asked. `/ready` on the metrics port is
 * what it can answer — whether it is actually carrying traffic.
 */
async function waitForTunnelReady(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(TUNNEL_READY_URL, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        return { connections: payload?.readyConnections ?? null };
      }
    } catch {
      // cloudflared takes a few seconds to register after Compose starts it.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function verifyPublicBackend(publicUrl) {
  const healthUrl = new URL('/api/v1/health', publicUrl);
  try {
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return;
    fail(`Public backend health returned HTTP ${response.status} at ${healthUrl}.`);
  } catch (error) {
    fail(`Public backend health is unreachable at ${healthUrl}: ${error.message}`);
  }
}

function updateMobileEnv(publicUrl) {
  const managed = {
    EXPO_PUBLIC_APP_ENV: 'remote-beta',
    EXPO_PUBLIC_API_BASE_URL: publicUrl,
  };
  const raw = existsSync(MOBILE_ENV) ? readFileSync(MOBILE_ENV, 'utf8').replace(/^\uFEFF/, '') : '';
  const existing = raw ? raw.split(/\r?\n/) : [];
  const seen = new Set();
  const next = existing.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && match[1] in managed) {
      seen.add(match[1]);
      return `${match[1]}=${managed[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(managed)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  writeFileSync(
    MOBILE_ENV,
    `${next.filter((line, index, all) => line !== '' || index < all.length - 1).join('\n')}\n`,
  );
  log('✓ Updated mobile/.env.local (remote-beta routing only)');
}

await preflight();

log('\n▸ Building and starting backend, gateway, and the Cloudflare tunnel…');
if (compose('up', '-d', '--build').status !== 0) fail('docker compose up failed.');

log('▸ Waiting for backend health…');
if (!(await waitForBackendHealthy())) fail('Backend did not become healthy in time.');
log('✓ Backend healthy');

log('▸ Waiting for the tunnel to register with Cloudflare…');
const tunnel = await waitForTunnelReady();
if (!tunnel)
  fail(
    'cloudflared did not register an edge connection. Inspect it with:\n' +
      '  docker compose --env-file backend/.env.local -f compose.yaml -f compose.remote-beta.yaml logs tunnel',
  );
log(`✓ Tunnel connected (${tunnel.connections ?? 'unknown'} edge connections)`);

/**
 * The hostname is the dashboard's to decide, not this script's.
 *
 * cloudflared cannot report what it is published as, so an absent hostname is
 * an ordinary state — the tunnel is up and the routes have not been added yet —
 * rather than a failure. Failing here would block the very step that fixes it.
 */
const publicUrl = readEnvValue('CLOUDFLARE_TUNNEL_HOSTNAME')
  ? `https://${readEnvValue('CLOUDFLARE_TUNNEL_HOSTNAME').replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  : null;

if (publicUrl) {
  log('▸ Verifying the public REST health endpoint…');
  await verifyPublicBackend(publicUrl);
  log('✓ Public REST health endpoint responding');
  updateMobileEnv(publicUrl);
} else {
  log(
    '\n  No CLOUDFLARE_TUNNEL_HOSTNAME set, so mobile/.env.local was left alone.\n' +
      '  Add a public hostname in Zero Trust → Networks → Tunnels → Public Hostnames,\n' +
      '  pointing at one of these Compose service URLs:\n' +
      '\n' +
      '    http://gateway:80                 API + websockets + Metro on one host\n' +
      '    http://backend:3000               REST API and websockets only\n' +
      '    http://web:5454                   administrator app only\n' +
      '    http://host.docker.internal:8082  Metro only\n' +
      '\n' +
      '  Then set CLOUDFLARE_TUNNEL_HOSTNAME in backend/.env.local and re-run.',
  );
}

log(`
────────────────────────────────────────────────
 TexasRenters remote beta ready

 Backend container : healthy
 Local backend     : http://127.0.0.1:3000
 Tunnel            : connected, ${tunnel.connections ?? '?'} edge connections
 Public gateway    : ${publicUrl ?? '(no CLOUDFLARE_TUNNEL_HOSTNAME set yet)'}
 REST API          : ${publicUrl ? `${publicUrl}/api/v1` : '(pending a public hostname)'}
 Mobile client     : mobile
 Tunnel metrics    : http://127.0.0.1:2000/ready (local only)

 Metro             : starting V2 on port 8082
 Next              : open Expo Go and scan the QR code below
────────────────────────────────────────────────
`);

const extraArgs = process.argv.slice(2).filter((argument) => argument !== '--');
if (!existsSync(PNPM_CLI)) {
  fail(
    `Corepack's pnpm entrypoint was not found at ${PNPM_CLI}.\n` +
      'Run corepack enable, then retry pnpm remote-beta.',
  );
}

// Launch pnpm through Node instead of pnpm.cmd. Node 24 on Windows can throw
// spawn EINVAL for .cmd shims when stdio is inherited.
const metro = spawn(process.execPath, [PNPM_CLI, 'run', 'start:tunnel', ...extraArgs], {
  cwd: join(ROOT, 'mobile'),
  stdio: 'inherit',
});
metro.on('error', (error) => fail(`V2 Metro could not be started: ${error.message}`));
metro.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
