import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const host = '127.0.0.1';
const port = Number(process.env.WEB_APP_PORT ?? 5454);

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
    console.log(`TexasRenters web app is already running at http://localhost:${port}.`);
  } else {
    console.error(
      `Port ${port} is occupied by another application. Stop that process or set WEB_APP_PORT to a free port.`,
    );
    process.exitCode = 1;
  }
} else {
  const nextBin = require.resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'dev', '--turbopack', '--port', String(port)], {
    env: process.env,
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => child.kill(signal));

  child.once('error', () => {
    console.error('Unable to start the TexasRenters web development server.');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
