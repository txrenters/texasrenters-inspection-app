#!/usr/bin/env node
/**
 * Cold-starts the temporary remote beta and launches mobile.
 *
 * One Docker-managed ngrok URL terminates at the remote-beta gateway:
 *   /api/* and /socket.io/* -> backend container
 *   every other path        -> V2 Metro on host port 8082
 *
 * Expo receives the public URL through EXPO_PACKAGER_PROXY_URL and therefore
 * does not create a competing ngrok agent session.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = join(ROOT, 'compose.remote-beta.yml');
const ENV_FILE = join(ROOT, 'backend', '.env.local');
const MOBILE_ENV = join(ROOT, 'mobile', '.env.local');
const NGROK_AGENT_API = 'http://127.0.0.1:4041/api/tunnels';
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

  if (!readEnvValue('NGROK_AUTHTOKEN')) fail('NGROK_AUTHTOKEN is missing from backend/.env.local.');
  if (!readEnvValue('NGROK_DOMAIN')) fail('NGROK_DOMAIN is missing from backend/.env.local.');

  log('✓ Docker, Compose, and required ngrok configuration are available');
}

const compose = (...args) =>
  run('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], {
    stdio: 'inherit',
  });

function readServiceHealth() {
  const result = run('docker', [
    'compose',
    '--env-file',
    ENV_FILE,
    '-f',
    COMPOSE_FILE,
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
          '  docker compose --env-file backend/.env.local -f compose.remote-beta.yml logs backend',
      );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

async function resolvePublicGateway(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(NGROK_AGENT_API, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const payload = await response.json();
        const tunnels = Array.isArray(payload?.tunnels) ? payload.tunnels : [];
        const gateway = tunnels.find(
          (candidate) =>
            candidate?.proto === 'https' &&
            typeof candidate?.public_url === 'string' &&
            String(candidate?.config?.addr ?? '').includes('gateway'),
        );
        if (gateway) return new URL(gateway.public_url).origin;
      }
    } catch {
      // The agent can take a few seconds to register after Compose starts it.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

async function verifyPublicBackend(publicUrl) {
  const healthUrl = new URL('/api/v1/health', publicUrl);
  try {
    const response = await fetch(healthUrl, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
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

log('\n▸ Building and starting backend, gateway, and ngrok…');
if (compose('up', '-d', '--build').status !== 0) fail('docker compose up failed.');

log('▸ Waiting for backend health…');
if (!(await waitForBackendHealthy())) fail('Backend did not become healthy in time.');
log('✓ Backend healthy');

log('▸ Resolving the live Docker-managed ngrok gateway…');
const publicUrl = await resolvePublicGateway();
if (!publicUrl)
  fail(
    'No HTTPS ngrok gateway was registered. Inspect it with:\n' +
      '  docker compose --env-file backend/.env.local -f compose.remote-beta.yml logs tunnel',
  );

log('▸ Verifying the public REST health endpoint…');
await verifyPublicBackend(publicUrl);
log('✓ Public REST health endpoint responding');

updateMobileEnv(publicUrl);

log(`
────────────────────────────────────────────────
 TexasRenters remote beta ready

 Backend container : healthy
 Local backend     : http://127.0.0.1:3000
 Public gateway    : ${publicUrl}
 REST API          : ${publicUrl}/api/v1
 Mobile client     : mobile
 Tunnel inspector  : http://127.0.0.1:4041 (local only)

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
