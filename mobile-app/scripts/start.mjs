import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mode = process.argv[2] === 'tunnel' ? 'tunnel' : 'lan';
const extraArguments = process.argv.slice(3);
const port = process.env.EXPO_PORT || '8081';
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configuredApiUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL || readLocalEnvironment('EXPO_PUBLIC_API_BASE_URL');
const lanAddress = findPreferredLanAddress();
const lanApiUrl =
  configuredApiUrl && lanAddress ? replaceLocalhost(configuredApiUrl, lanAddress) : null;

if (lanApiUrl) process.env.EXPO_PUBLIC_DEV_LAN_API_BASE_URL = lanApiUrl;
process.stdout.write(
  [
    `Expo project root: ${projectRoot}`,
    `Starting Expo in ${mode.toUpperCase()} mode on port ${port}.`,
    lanAddress ? `Selected LAN candidate: ${lanAddress}` : 'No private LAN candidate detected.',
    lanApiUrl ? `Development API fallback: ${lanApiUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n') + '\n',
);

const expoCli = require.resolve('expo/bin/cli');
const child = spawn(
  process.execPath,
  [expoCli, 'start', `--${mode}`, '--port', port, ...extraArguments],
  { cwd: projectRoot, env: process.env, stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

function readLocalEnvironment(name) {
  try {
    const contents = readFileSync(join(projectRoot, '.env.local'), 'utf8');
    const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name}=`));
    return (
      line
        ?.slice(line.indexOf('=') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '') || null
    );
  } catch {
    return null;
  }
}

function findPreferredLanAddress() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) => address.family === 'IPv4' && !address.internal && isPrivate(address.address),
      )
      .map((address) => ({
        address: address.address,
        score:
          (/wi-?fi|wireless|ethernet/i.test(name) ? 10 : 0) -
          (/virtual|vethernet|wsl|docker|hyper-v/i.test(name) ? 20 : 0),
      })),
  );
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.address ?? null;
}

function isPrivate(address) {
  const [first, second] = address.split('.').map(Number);
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function replaceLocalhost(value, address) {
  try {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null;
    url.hostname = address;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
