import { sessionStorage } from './session-storage';

/**
 * A stable name for this handset, so signing in again is not mistaken for a
 * second phone.
 *
 * The account is held to one device at a time. That check compared "is any
 * live session open", which cannot tell a reinstall from a colleague: an
 * uninstall never reaches the server, so the refresh token outlives the app
 * that owned it and the next install is refused for the rest of its thirty
 * days. A technician who reinstalled was told to take their own phone over.
 *
 * **Not a secret and not a credential.** It only decides whether somebody is
 * *asked* to take a session over. Copying it gains nothing: an attacker would
 * still need the password, and with the password they could take the session
 * over anyway.
 *
 * Stored under its own key, deliberately separate from the session, so signing
 * out leaves it behind — otherwise every sign-out would make the same phone
 * look new. On iOS this lands in the Keychain, which survives an uninstall, so
 * a reinstalled app reclaims its own session silently. Android clears app
 * storage on uninstall and will still be asked once, which is what the
 * take-over prompt is for.
 */
const DEVICE_KEY = 'texasrenters.device';

/**
 * Long enough not to collide across a company's handsets, short enough for the
 * column that holds it. Not required to be unguessable — see above.
 */
function newDeviceId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function deviceId(): Promise<string | undefined> {
  try {
    const existing = await sessionStorage.getItem(DEVICE_KEY);
    if (existing) return existing;

    const created = newDeviceId();
    await sessionStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    // Secure storage can refuse — a locked keychain, a device policy. Signing
    // in matters more than recognising the handset, so this degrades to the
    // previous behaviour: an unknown device, which is asked to take over.
    return undefined;
  }
}
