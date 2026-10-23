#!/usr/bin/env node
/**
 * Fails an image build whose Node is older than the root package.json allows.
 *
 * `engines.node` names the first patched release of each line (the October 2026
 * security release fixed a Brotli decoder RCE that any unauthenticated POST to
 * the API reaches). npm only warns about engines, and both Dockerfiles take
 * whatever `node:24-bookworm-slim` resolves to, so without this a stale cached
 * base or a registry mirror lagging behind would ship a vulnerable runtime and
 * report a green build.
 *
 * Runs in each runtime stage, the stage that ships, with package.json and this
 * file bind-mounted so neither lands in a layer. semver comes from the npm the
 * base image bundles; the runtime stage has no node_modules of its own yet.
 *
 * When a new Node security release lands, raise `engines.node` in package.json
 * (and the copy in package-lock.json) and the next image build enforces it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [packageJsonPath = 'package.json'] = process.argv.slice(2);
const range = JSON.parse(readFileSync(packageJsonPath, 'utf8')).engines?.node;
if (!range) {
  console.error(`No engines.node in ${packageJsonPath}; refusing to guess which Node is patched.`);
  process.exit(1);
}

const require = createRequire('/usr/local/lib/node_modules/npm/');
const semver = require('semver');

if (!semver.satisfies(process.version, range)) {
  console.error(
    `Node ${process.version} is not in engines.node (${range}). ` +
      'The base image is older than the last security release; rebuild with a fresh pull.',
  );
  process.exit(1);
}
console.log(`Node ${process.version} satisfies engines.node (${range}).`);
