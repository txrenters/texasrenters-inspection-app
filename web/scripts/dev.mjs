import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';

/**
 * Port 5456, deliberately clear of the Docker stack.
 *
 * The `web` container publishes 5454 (`WEB_PORT` in the compose files) and is
 * routinely up while this dev server is worked on. Sharing a port would mean the
 * two silently take turns, and whichever answered would look like the other one
 * failing to pick up a change — which matters more than usual here, because the
 * container serves a production build with no hot reload.
 *
 * `WEB_DEV_PORT`, not `WEB_PORT`: those are two different things, and naming the
 * dev server after the container port is how someone ends up pointing this at
 * 5454 and wondering which one they are looking at.
 */
const require = createRequire(import.meta.url);
const host = '127.0.0.1';
const port = Number(process.env.WEB_DEV_PORT ?? 5456);

function portIsListening() {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(750);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const unavailable = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', unavailable);
    socket.once('timeout', unavailable);
  });
}

async function texasRentersIsRunning() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://${host}:${port}/login`, { signal: controller.signal });
    const html = await response.text();
    return html.includes('TexasRenters Admin');
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const listening = await portIsListening();

if (listening) {
  if (await texasRentersIsRunning()) {
    console.log(`The TexasRenters console is already running at http://localhost:${port}.`);
  } else {
    console.error(
      `Port ${port} is occupied by another application. Stop that process or set WEB_DEV_PORT to a free port.`,
    );
    process.exitCode = 1;
  }
} else {
  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'dev', '--turbopack', '--port', String(port)], {
    env: process.env,
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

  child.once('error', () => {
    console.error('Unable to start the TexasRenters console development server.');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
