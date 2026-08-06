#!/usr/bin/env node
/**
 * Read or set the account's Cloudflare Stream webhook, and print the signing
 * secret so it can be pasted into the backend environment.
 *
 * Cloudflare exposes exactly **one** Stream webhook per account
 * (`GET`/`PUT /accounts/{id}/stream/webhook`), so registering a new URL
 * replaces whatever was there. That is easy to do by accident when a developer
 * points it at their own tunnel and takes production's notifications with it,
 * which is why `set` refuses to overwrite a different URL without --force.
 *
 * The secret is printed and never written anywhere. A script that edited
 * `.env.local` would eventually be run against the wrong file, and a secret in
 * a committed file is a secret that has to be rotated.
 *
 * Usage:
 *   node scripts/configure-cloudflare-stream-webhook.mjs get
 *   node scripts/configure-cloudflare-stream-webhook.mjs set [--url <url>] [--force]
 */

const API_ROOT = 'https://api.cloudflare.com/client/v4';

const [, , command = 'get', ...rest] = process.argv;
const flags = new Set(rest.filter((value) => value.startsWith('--')));
const urlFlagIndex = rest.indexOf('--url');
const urlOverride = urlFlagIndex >= 0 ? rest[urlFlagIndex + 1] : undefined;

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const apiToken = process.env.CLOUDFLARE_STREAM_API_TOKEN?.trim();
const configuredUrl = (urlOverride ?? process.env.CLOUDFLARE_STREAM_WEBHOOK_URL)?.trim();

/** Anything that could carry a credential is scrubbed before it reaches a log. */
function redact(text) {
  let safe = String(text);
  for (const secret of [apiToken].filter(Boolean)) safe = safe.split(secret).join('«redacted»');
  return safe;
}

function fail(message) {
  console.error(`\n  ${redact(message)}\n`);
  process.exit(1);
}

if (!accountId || !apiToken)
  fail(
    'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_STREAM_API_TOKEN first.\n' +
      '  The token needs Stream:Read to view the webhook and Stream:Edit to set it.',
  );

async function callCloudflare(method, body) {
  let response;
  try {
    response = await fetch(`${API_ROOT}/accounts/${accountId}/stream/webhook`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    fail(`Could not reach the Cloudflare API: ${redact(error?.message ?? error)}`);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const detail = payload?.errors?.map((item) => `${item.code}: ${item.message}`).join('; ');
    // 403 here is nearly always the token's permissions rather than the account.
    const hint =
      response.status === 403
        ? '\n  A 403 usually means the API token lacks Stream:Read (get) or Stream:Edit (set).'
        : '';
    fail(`Cloudflare rejected the request (${response.status}). ${detail ?? ''}${hint}`);
  }
  return payload.result ?? {};
}

function report(result) {
  console.log(`\n  Notification URL : ${result.notificationUrl || '(none configured)'}`);
  console.log(`  Modified         : ${result.modified ?? 'unknown'}`);

  if (!result.secret) {
    // Cloudflare only returns the secret on the call that creates or rotates
    // it, so this is the normal answer for a plain read.
    console.log('  Signing secret   : not returned by this call');
    console.log(
      '\n  Run `set` to (re)register the webhook if you need the secret; Cloudflare\n' +
        '  returns it with the registration response.\n',
    );
    return;
  }

  console.log('  Signing secret   : returned below\n');
  console.log('  Copy this line into backend/.env.local — it is not saved for you:\n');
  console.log(`CLOUDFLARE_STREAM_WEBHOOK_SECRET=${result.secret}\n`);
  console.log('  Then restart the backend so the guard picks it up.\n');
}

if (command === 'get') {
  report(await callCloudflare('GET'));
} else if (command === 'set') {
  if (!configuredUrl)
    fail(
      'No webhook URL. Set CLOUDFLARE_STREAM_WEBHOOK_URL or pass --url <url>.\n' +
        '  It must be publicly reachable: Cloudflare cannot call localhost or a\n' +
        '  private LAN address, so use the project tunnel for local testing.',
    );
  if (!/^https:\/\//.test(configuredUrl)) fail(`The webhook URL must be HTTPS: ${configuredUrl}`);

  const existing = await callCloudflare('GET');
  if (
    existing.notificationUrl &&
    existing.notificationUrl !== configuredUrl &&
    !flags.has('--force')
  ) {
    // One webhook per account. Replacing it silently is how a developer's
    // tunnel quietly stops production from ever hearing that a video is ready.
    console.error('\n  This account already has a Stream webhook registered:\n');
    console.error(`    current : ${existing.notificationUrl}`);
    console.error(`    new     : ${configuredUrl}\n`);
    console.error('  Cloudflare allows one webhook per account, so this REPLACES the current');
    console.error('  one and any environment relying on it stops receiving notifications.');
    console.error('  Re-run with --force if that is what you want.\n');
    process.exit(1);
  }

  report(await callCloudflare('PUT', { notificationUrl: configuredUrl }));
} else {
  fail(`Unknown command "${command}". Use "get" or "set".`);
}
