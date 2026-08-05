#!/usr/bin/env node
/**
 * Validates the merged Compose configuration and prints it without secrets.
 *
 * `docker compose config` resolves `env_file` into each service's
 * `environment:` block, so running it against this repo prints the live
 * contents of backend/.env.local — API keys, the credentials encryption key,
 * the database password. It did exactly that once, into a terminal transcript,
 * which is why this wrapper exists.
 *
 * Compose still does the parsing and merging, so the validation is real: an
 * invalid file, a bad override or an unresolvable variable still fails here.
 * Only the rendering is ours, and it shows the things this command is actually
 * consulted for — the project name, which services exist, what they publish,
 * and what they wait on.
 *
 * `--no-interpolate` also happens to suppress the values, but it does so as a
 * side effect of leaving `${...}` unexpanded rather than by intent. Deleting
 * the block is the guarantee.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const result = spawnSync('docker', ['compose', ...args, 'config', '--format', 'json'], {
  encoding: 'utf8',
  shell: false,
});

if (result.error) {
  console.error(`Could not run docker compose: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  // Compose's own diagnostics name the file and line, and describe a
  // configuration problem rather than an environment value.
  console.error(result.stderr.trim() || 'docker compose config failed.');
  process.exit(result.status ?? 1);
}

let config;
try {
  config = JSON.parse(result.stdout);
} catch {
  console.error('docker compose returned output that is not JSON.');
  process.exit(1);
}

const services = Object.entries(config.services ?? {}).sort(([a], [b]) => a.localeCompare(b));

console.log(`project: ${config.name}`);
console.log(`services: ${services.length}`);
for (const [name, service] of services) {
  const detail = [];
  if (service.build?.dockerfile) detail.push(`build ${service.build.dockerfile}`);
  else if (service.image) detail.push(service.image);
  const published = (service.ports ?? [])
    .map((port) => `${port.published ?? '?'}->${port.target ?? '?'}`)
    .join(' ');
  if (published) detail.push(`ports ${published}`);
  const waitsOn = Object.keys(service.depends_on ?? {});
  if (waitsOn.length) detail.push(`after ${waitsOn.join(', ')}`);
  if (service.profiles?.length) detail.push(`profiles ${service.profiles.join(', ')}`);
  console.log(`  ${name}: ${detail.join(' | ') || 'no build, ports or dependencies'}`);
}
// Named rather than silently omitted, so nobody reads a short output as a
// service having no configuration.
console.log('\nenvironment and env_file are omitted: they resolve to real secrets.');
