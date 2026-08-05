#!/usr/bin/env node
/** Safe status snapshot of the V2 remote-beta session. Prints no secrets. */
import { spawnSync } from 'node:child_process';
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

let publicUrl = null;
let upstream = null;
try {
  const response = await fetch('http://127.0.0.1:4041/api/tunnels');
  if (response.ok) {
    const body = await response.json();
    const tunnel = (body.tunnels ?? []).find(
      (candidate) =>
        candidate.public_url?.startsWith('https://') &&
        String(candidate?.config?.addr ?? '').includes('gateway'),
    );
    publicUrl = tunnel?.public_url ?? null;
    upstream = tunnel?.config?.addr ?? null;
  }
} catch {
  // Agent is not running.
}

console.log(`\nPublic gateway: ${publicUrl ?? '(ngrok gateway unavailable)'}`);
console.log(`Tunnel upstream: ${upstream ?? '(unavailable)'}`);

if (publicUrl) {
  try {
    const started = Date.now();
    const response = await fetch(`${publicUrl}/api/v1/health`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
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
