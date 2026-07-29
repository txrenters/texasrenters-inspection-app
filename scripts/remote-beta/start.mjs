#!/usr/bin/env node
/**
 * Brings up the temporary remote iOS beta environment.
 *
 *   node scripts/remote-beta/start.mjs
 *
 * Backend and Metro need two separate public paths: the Expo tunnel carries only
 * the JavaScript bundle and dev assets, never the REST API. This script wires the
 * API half (Docker + Cloudflare Tunnel), writes the resulting public URL into the
 * ignored mobile env file, and then hands off to Metro's own Expo/ngrok tunnel.
 *
 * It never prints a secret value.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = join(ROOT, 'compose.remote-beta.yml');
// One secret file: backend/.env.local holds every backend credential and is used
// by Compose for both interpolation and the container's runtime environment.
const ENV_FILE = join(ROOT, 'backend', '.env.local');
const MOBILE_ENV = join(ROOT, 'mobile-app', '.env.local');
// cloudflared prints its public URL to stdout; unlike ngrok there is no local
// agent API to query, so the URL is read back from the container logs.
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok-free\.(?:app|dev))/i;

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

// --- preflight ---------------------------------------------------------------
function preflight() {
  if (run('docker', ['--version']).status !== 0)
    fail('Docker is not available. Start Docker Desktop and retry.');
  if (run('docker', ['compose', 'version']).status !== 0)
    fail('Docker Compose v2 is not available.');
  if (!existsSync(ENV_FILE))
    fail(`Missing ${ENV_FILE} — the backend environment file is required.`);

  // cloudflared quick tunnels need no account or token, so there is nothing
  // secret to verify here. ngrok is now used only by Expo for Metro.
  log('✓ Docker and Compose available');
}

const compose = (...args) =>
  run('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
  });

// --- wait for health ---------------------------------------------------------
/**
 * Reads container health from `ps --format json`.
 *
 * A Go template such as `{{.Service}} {{.Health}}` cannot be used here: this runs
 * through the shell on Windows, and PowerShell mangles the braces and the space,
 * so the output never matches and a perfectly healthy backend reads as a
 * timeout. `json` has no shell-special characters.
 */
function readServiceHealth() {
  const out = run('docker', [
    'compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, 'ps', '--format', 'json',
  ]);
  const text = (out.stdout ?? '').trim();
  if (!text) return new Map();
  // Compose emits either one object per line or a single array, by version.
  let rows;
  try {
    rows = text.startsWith('[')
      ? JSON.parse(text)
      : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return new Map();
  }
  return new Map(rows.map((row) => [row.Service, (row.Health || '').toLowerCase()]));
}

async function waitForBackendHealthy(timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const health = readServiceHealth().get('backend');
    if (health === 'healthy') return true;
    if (health === 'unhealthy')
      fail(
        'Backend container reported unhealthy. Inspect:\n' +
          '  docker compose --env-file backend/.env.local -f compose.remote-beta.yml logs backend',
      );
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// --- public URL --------------------------------------------------------------
/**
 * A named tunnel serves a hostname you own, which never appears in the logs — so
 * it is declared up front via REMOTE_BETA_API_URL. A quick tunnel prints its
 * random *.trycloudflare.com URL to stdout and is read back from there.
 */
function configuredApiUrl() {
  const raw = readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '');
  // NGROK_DOMAIN pins a stable hostname, so the URL is known up front and needs
  // no discovery from logs or the agent API.
  const domain = raw.match(/^NGROK_DOMAIN=(.+)$/m);
  if (domain?.[1]?.trim()) return `https://${domain[1].trim().replace(/^https?:\/\//, '')}`;
  const match = raw.match(/^REMOTE_BETA_API_URL=(.+)$/m);
  if (!match) return null;
  const value = match[1].trim().replace(/\/$/, '');
  // Guard against the documentation placeholder being pasted verbatim: trusting
  // it skips log discovery and every request then targets a domain that does not
  // exist.
  if (!value || /yourdomain\.com|example\.com|<.*>/i.test(value)) {
    log(`  (ignoring placeholder REMOTE_BETA_API_URL: ${value})`);
    return null;
  }
  return value;
}

/** Reads the quick-tunnel URL the running container is actually serving. */
async function resolveFromLogs(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const logs = run('docker', [
      'compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, 'logs', 'tunnel',
    ]);
    const match = `${logs.stdout ?? ''}${logs.stderr ?? ''}`.match(TUNNEL_URL_PATTERN);
    if (match) return match[0].replace(/\/$/, '');
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function resolvePublicUrl(timeoutMs = 120_000) {
  return configuredApiUrl() ?? (await resolveFromLogs(timeoutMs));
}

// --- mobile env --------------------------------------------------------------
/** Rewrites only the keys this session owns; every other local value survives. */
function updateMobileEnv(publicUrl) {
  const managed = {
    EXPO_PUBLIC_APP_ENV: 'remote-beta',
    EXPO_PUBLIC_API_BASE_URL: publicUrl,
  };
  // Strip a UTF-8 BOM before parsing. An editor-written file starts with EF BB BF,
  // which stopped the key regex matching line 1 and caused a duplicate
  // EXPO_PUBLIC_API_BASE_URL to be appended rather than the existing one replaced.
  const raw = existsSync(MOBILE_ENV) ? readFileSync(MOBILE_ENV, 'utf8').replace(/^﻿/, '') : '';
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
  writeFileSync(MOBILE_ENV, next.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n');
  log(`✓ Updated mobile-app/.env.local (${Object.keys(managed).length} managed keys)`);
}

// --- main --------------------------------------------------------------------
preflight();

log('\n▸ Building and starting backend…');
if (compose('up', '-d', '--build').status !== 0) fail('docker compose up failed.');

log('▸ Waiting for backend health…');
if (!(await waitForBackendHealthy())) fail('Backend did not become healthy in time.');
log('✓ Backend healthy');

log('▸ Resolving public Cloudflare tunnel URL…');
const publicUrl = await resolvePublicUrl();
if (!publicUrl)
  fail(
    'No Cloudflare tunnel URL found. Check: docker compose ' +
      '--env-file backend/.env.local -f compose.remote-beta.yml logs tunnel',
  );

log('▸ Verifying the public health endpoint…');
async function healthy(url) {
  try {
    return (await fetch(`${url}/api/v1/health`)).ok;
  } catch {
    return false;
  }
}

let activeUrl = publicUrl;
if (!(await healthy(activeUrl))) {
  // A configured hostname can be stale or wrong. Rather than stopping, fall back
  // to whatever URL the running tunnel is actually serving.
  log('  configured URL did not respond — falling back to the live tunnel URL…');
  const discovered = await resolveFromLogs();
  if (discovered && discovered !== activeUrl && (await healthy(discovered))) {
    activeUrl = discovered;
  } else {
    fail(
      `Public health check failed at ${publicUrl}/api/v1/health
` +
        '  If REMOTE_BETA_API_URL is set in backend/.env.local, remove it unless it is a real hostname.',
    );
  }
}
const publicUrlFinal = activeUrl;
log('✓ Public health endpoint responding');

updateMobileEnv(publicUrlFinal);

log(`
────────────────────────────────────────────────
 TexasRenters remote beta ready

 Backend container : healthy
 Local backend     : http://127.0.0.1:${process.env.PORT ?? 3000}
 Public API        : ${publicUrlFinal}
 Mobile env        : remote-beta
 Tunnel metrics    : http://127.0.0.1:2000  (local only)

 Metro             : starting Expo tunnel…
 Next              : open Expo Go and scan the QR code below
────────────────────────────────────────────────
`);

const metro = spawn('pnpm', ['run', 'start:tunnel'], {
  cwd: join(ROOT, 'mobile-app'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
metro.on('exit', (code) => process.exit(code ?? 0));
