#!/usr/bin/env node
/**
 * Stops the remote-beta services.
 *
 * Deliberately never passes `-v`: volumes are not removed during ordinary
 * shutdown, and no unsynchronised technician work is discarded.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
console.log(
  'Before stopping, confirm testers have finished recording and pending uploads are 0.\n',
);
const result = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    join(ROOT, 'backend', '.env.local'),
    '-f',
    join(ROOT, 'compose.yaml'),
    '-f',
    join(ROOT, 'compose.remote-beta.yaml'),
    'down',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 0);
