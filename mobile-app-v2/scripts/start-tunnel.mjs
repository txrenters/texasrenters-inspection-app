#!/usr/bin/env node

/**
 * Starts Metro through Expo's ngrok tunnel while sending app data through the
 * separate Docker/ngrok REST tunnel. The two public URLs have different jobs:
 *
 *   Expo tunnel  -> JavaScript bundle and development assets
 *   Docker ngrok -> TexasRenters REST API and realtime socket
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
        'Start compose.remote-beta.yml first, then retry pnpm start:tunnel.',
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
        String(candidate?.config?.addr ?? '').includes('backend'),
    ) ??
    tunnels.find(
      (candidate) => candidate?.proto === 'https' && typeof candidate?.public_url === 'string',
    );
  if (!tunnel)
    fail('No HTTPS backend tunnel is registered. Check the Docker tunnel service logs.');

  return new URL(tunnel.public_url).origin;
}

async function verifyBackend(publicUrl) {
  const healthUrl = new URL('/api/v1/health', publicUrl);
  let response;
  try {
    response = await fetch(healthUrl, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(`The public backend tunnel is registered but ${healthUrl} is unreachable.`);
  }
  if (!response.ok)
    fail(`The public backend health check returned HTTP ${response.status} at ${healthUrl}.`);
}

const publicApiUrl = await discoverBackendUrl();
await verifyBackend(publicApiUrl);

console.log('TexasRenters tunnel routing verified:');
console.log(`  REST API : ${publicApiUrl}`);
const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  console.log('  Metro    : configuration check only; not started');
} else {
  console.log('  Metro    : starting a separate Expo tunnel on port 8082');

  const extraArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== '--' && argument !== '--check');
  const expoCli = require.resolve('expo/bin/cli');
  const child = spawn(
    process.execPath,
    [expoCli, 'start', '--tunnel', '--go', '--port', '8082', ...extraArgs],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EXPO_PUBLIC_APP_ENV: 'remote-beta',
        EXPO_PUBLIC_API_BASE_URL: publicApiUrl,
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
