#!/usr/bin/env node
/** Safe status snapshot of the remote-beta session. Prints no secrets. */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = ['compose', '--env-file', join(ROOT, 'backend', '.env.local'),
  '-f', join(ROOT, 'compose.remote-beta.yml')];
const sh = process.platform === 'win32';

// `json` rather than a Go template: this runs through the shell on Windows, and
// PowerShell mangles the braces and tabs, so a running stack reads as empty.
const ps = spawnSync('docker', [...args, 'ps', '--format', 'json'], { encoding: 'utf8', shell: sh });
const text = (ps.stdout ?? '').trim();
let rows = [];
if (text) {
  try {
    // Compose emits either one object per line or a single array, by version.
    rows = text.startsWith('[')
      ? JSON.parse(text)
      : text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    rows = [];
  }
}
console.log(
  'Services:\n' +
    (rows.length
      ? rows.map((r) => `  ${r.Service}  ${r.State}  ${r.Health || '-'}`).join('\n')
      : '  (none running)'),
);

let publicUrl = null;
try {
  const res = await fetch('http://127.0.0.1:4040/api/tunnels');
  if (res.ok) {
    const body = await res.json();
    publicUrl = (body.tunnels ?? []).find((t) => t.public_url?.startsWith('https://'))?.public_url ?? null;
  }
} catch { /* agent down */ }
console.log('\nPublic API: ' + (publicUrl ?? '(ngrok agent unreachable)'));

if (publicUrl) {
  try {
    const started = Date.now();
    const res = await fetch(`${publicUrl}/api/v1/health`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    console.log(`Health    : ${res.status} in ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`Health    : unreachable (${error.message})`);
  }
}
