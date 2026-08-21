#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

// Expo's testflight@1.0.4 wrapper calls spawn('npx'), which cannot launch the
// npx.cmd shim on Windows without a shell. Node 24 also refuses to spawn
// npm.cmd directly, so invoke npm's JavaScript entry point with Node and avoid
// platform command shims altogether.
const npmCliCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
];
const npmCli = npmCliCandidates.find((candidate) => candidate && existsSync(candidate));

if (!npmCli) {
  console.error('Unable to locate npm-cli.js. Reinstall Node.js with npm included.');
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    npmCli,
    'exec',
    '--yes',
    '--package',
    'eas-cli@latest',
    '--',
    'eas',
    'build',
    '--platform',
    'ios',
    '--profile',
    'production',
    '--auto-submit',
    ...process.argv.slice(2),
  ],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
);

child.on('error', (error) => {
  console.error(`Unable to start EAS CLI: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`EAS CLI stopped after receiving ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
