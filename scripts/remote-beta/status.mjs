#!/usr/bin/env node
/** Safe status snapshot of the V2 remote-beta session. Prints no secrets. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = join(ROOT, 'backend', '.env.local');
// The web image inlines NEXT_PUBLIC_* at build time, and interpolation only
// reads --env-file and the root .env — never a service's env_file.
const WEB_ENV_FILE = join(ROOT, 'web-app', '.env.local');
const COMPOSE_FILES = [
  '-f',
  join(ROOT, 'compose.yaml'),
  '-f',
  join(ROOT, 'compose.remote-beta.yaml'),
];
const result = spawnSync(
  'docker',
  ['compose', '--env-file', ENV_FILE, '--env-file', WEB_ENV_FILE, ...COMPOSE_FILES, 'ps', '--format', 'json'],
  { encoding: 'utf8' },
);
const text = (result.stdout ?? '').trim();
let rows = [];
if (text) {
  try {
    rows = text.startsWith('[')
      ? JSON.parse(text)
      : text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
  } catch {
    rows = [];
  }
}

console.log(
  'Services:\n' +
    (rows.length
      ? rows.map((row) => `  ${row.Service}  ${row.State}  ${row.Health || '-'}`).join('\n')
      : '  (none running)'),
);

/**
 * cloudflared cannot be asked what it is published as — a token-based tunnel
 * receives its hostnames from the dashboard and never learns them. So this
 * reports the two things it can know: whether the tunnel is carrying traffic,
 * and which hostname we were told to expect.
 */
let readyConnections = null;
try {
  const response = await fetch('http://127.0.0.1:2000/ready', {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.ok) readyConnections = (await response.json().catch(() => null))?.readyConnections ?? 0;
} catch {
  // Not running, or still registering.
}

const configuredHostname = (() => {
  try {
    const raw = readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '');
    return raw.match(/^CLOUDFLARE_TUNNEL_HOSTNAME=(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
})();
const publicUrl = configuredHostname
  ? `https://${configuredHostname.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
  : null;

console.log(
  `\nTunnel edge   : ${
    readyConnections === null
      ? '(cloudflared metrics unreachable — is the tunnel running?)'
      : `${readyConnections} ready connection${readyConnections === 1 ? '' : 's'}`
  }`,
);
console.log(`Public gateway: ${publicUrl ?? '(no CLOUDFLARE_TUNNEL_HOSTNAME configured)'}`);

if (publicUrl) {
  try {
    const started = Date.now();
    const response = await fetch(`${publicUrl}/api/v1/health`, {
    });
    console.log(`REST health    : ${response.status} in ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`REST health    : unreachable (${error.message})`);
  }
}

try {
  const response = await fetch('http://127.0.0.1:8082/status');
  const body = await response.text();
  console.log(`V2 Metro       : ${response.status} ${body.trim()}`);
} catch {
  console.log('V2 Metro       : stopped');
}
