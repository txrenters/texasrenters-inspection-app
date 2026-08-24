/**
 * The release this build came from.
 *
 * `NEXT_PUBLIC_APP_VERSION` is set from the image tag when CI publishes, so the
 * console can state which release is serving it without anyone reading the
 * server. It is inlined at build time like every NEXT_PUBLIC_* value, which is
 * exactly right here — the version *is* a property of the build, and one that
 * could be changed by restarting the container would be worthless.
 *
 * Deliberately not `package.json`. That version is a scaffolded 0.1.0 nobody
 * has maintained, and a number that never moves is worse than none: it invites
 * somebody to conclude a deploy landed when it did not.
 */
const raw = process.env.NEXT_PUBLIC_APP_VERSION?.trim();

/** `v1.0.2`, or `dev` for a build that was never published from a release. */
export const APP_VERSION_LABEL = raw ? (raw.startsWith('v') ? raw : `v${raw}`) : 'dev';
