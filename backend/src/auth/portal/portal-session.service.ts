import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { setPortalSessionCheck } from '../../common/auth';
import { openSecret, sealSecret } from '../../common/secret-envelope';
import { PortalClient } from './portal.client';
import {
  CONSOLE_RENEWAL_MARGIN_SECONDS,
  PORTAL_SESSION_MAX_SECONDS,
  portalTokenKey,
  readPortalConfig,
  type PortalSettings,
} from './portal.config';
import { PortalStore, PortalStoreUnavailableError, type PortalSessionRecord } from './portal.store';

/**
 * The life of a signed-in TR Staff Portal session after sign-in: whether it is
 * still live, re-checking it with the portal, and ending it.
 *
 * **How "re-check on every request" works here.** The console renews its
 * access token before every request that needs it, under a lock shared by all
 * its tabs. A portal session's access token lives only until its next check is
 * due, so the renewal that arrives at that moment is the one that asks the
 * portal. No request ever runs on a check older than PORTAL_RECHECK_MINUTES,
 * and an ordinary API call never waits on the portal.
 */

/** The renewal answer for a portal session. */
export type PortalRenewal = { live: true; accessTtlSeconds: number } | { live: false };

/** How long one renewal may hold a session's lock. Longer than the portal's ten-second timeout. */
const LOCK_TTL_MS = 20_000;
/** How long a renewal waits for another one already asking the portal about the same session. */
const LOCK_WAIT_MS = 12_000;
const LOCK_POLL_MS = 100;
/**
 * The access token handed out while the portal cannot be reached.
 *
 * Short, so the console asks again about a minute later: "try again on the
 * next request" without trying on every one.
 */
const UNAVAILABLE_ACCESS_TTL_SECONDS = 2 * CONSOLE_RENEWAL_MARGIN_SECONDS;

@Injectable()
export class PortalSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PortalSessionService.name);

  constructor(
    @Inject(PortalStore) private readonly store: PortalStore,
    @Inject(PortalClient) private readonly client: PortalClient,
  ) {}

  onModuleInit() {
    setPortalSessionCheck((portalSessionId, authUserId) => this.isLive(portalSessionId, authUserId));
    const config = readPortalConfig();
    // Once, at boot, by name only: a portal switched on but unusable is off, and
    // someone needs to be told why the button never appeared.
    if (config.requested && !config.enabled)
      this.logger.error({ event: 'portal_misconfigured', missingOrInvalid: config.problems });
  }

  onModuleDestroy() {
    setPortalSessionCheck(undefined);
  }

  /** Whether password sign-in is still allowed for staff on the console. */
  passwordLoginAllowed() {
    return readPortalConfig().allowPasswordLogin;
  }

  /**
   * Starts a portal session after a successful sign-in.
   *
   * Written before this app's own session is issued, so a session that could
   * not be stored is refused rather than issued uncheckable.
   */
  async begin(portalSessionId: string, input: { authUserId: string; subject: string; refreshToken: string }) {
    const settings = this.settings();
    if (!settings) throw new PortalStoreUnavailableError();
    const now = Date.now();
    await this.store.saveSession(
      portalSessionId,
      {
        authUserId: input.authUserId,
        subject: input.subject,
        refreshToken: sealSecret(input.refreshToken, portalTokenKey(settings)),
        checkedAt: now,
        startedAt: now,
      },
      PORTAL_SESSION_MAX_SECONDS,
    );
    return { accessTtlSeconds: settings.recheckSeconds };
  }

  /**
   * Whether a portal session may still be used. Called on every request that
   * carries a portal session's access token.
   *
   * Live while its record exists and belongs to this account. If Redis cannot
   * be reached it stays live, and that is safe: a sign-out is also written to
   * Postgres, where the next renewal refuses it, at most one re-check later.
   */
  async isLive(portalSessionId: string, authUserId: string) {
    if (!this.settings()) return false;
    try {
      const record = await this.store.readSession(portalSessionId);
      return record?.authUserId === authUserId;
    } catch (error) {
      if (error instanceof PortalStoreUnavailableError) return true;
      throw error;
    }
  }

  /**
   * Renews a portal session's access token, asking the portal first when a
   * check is due.
   *
   * Refreshes at most once per portal refresh token, however many requests
   * arrive together. The portal rotates its refresh token on every use and
   * revokes the old one, so two parallel refreshes would revoke each other and
   * sign the person out. One renewal holds the session's lock and asks; any
   * other waits, reads what it learned, and never sends the token itself.
   * Every request reads the one record for its own session, so none can be left
   * holding a token that has already been rotated, or use another session's.
   */
  async renew(portalSessionId: string, authUserId: string): Promise<PortalRenewal> {
    const settings = this.settings();
    if (!settings) return { live: false };
    try {
      const record = await this.store.readSession(portalSessionId);
      if (!record || record.authUserId !== authUserId) return { live: false };
      const notDue = this.ttlUntilDue(settings, record);
      if (notDue) return { live: true, accessTtlSeconds: notDue };

      const lock = await this.store.acquireLock(portalSessionId, LOCK_TTL_MS);
      if (!lock) return await this.followCheck(settings, portalSessionId, authUserId, record);
      try {
        return await this.check(settings, portalSessionId, authUserId);
      } finally {
        await this.store.releaseLock(portalSessionId, lock).catch(() => undefined);
      }
    } catch (error) {
      if (!(error instanceof PortalStoreUnavailableError)) throw error;
      this.logger.warn({ event: 'portal_recheck_deferred', reason: 'store unavailable' });
      return { live: true, accessTtlSeconds: UNAVAILABLE_ACCESS_TTL_SECONDS };
    }
  }

  /** Ends one portal session: this app's sign-out. Best effort; Postgres has already ended the session. */
  async end(portalSessionId: string, authUserId: string) {
    await this.store.endSession(portalSessionId, authUserId).catch(() => undefined);
  }

  /** Ends every portal session one account has: a back-channel logout. */
  async endAllFor(authUserId: string) {
    return this.store.endSessionsOf(authUserId);
  }

  /** Where someone who signed in through the portal lands after signing out, when it is on. */
  signedOutUrl() {
    return this.settings()?.signedOutUrl;
  }

  /** The re-check itself, under the lock. */
  private async check(settings: PortalSettings, portalSessionId: string, authUserId: string): Promise<PortalRenewal> {
    // Read again now the lock is held: the previous holder may have just
    // finished, and its answer is the one to use.
    const current = await this.store.readSession(portalSessionId);
    if (!current || current.authUserId !== authUserId) return { live: false };
    const notDue = this.ttlUntilDue(settings, current);
    if (notDue) return { live: true, accessTtlSeconds: notDue };

    const key = portalTokenKey(settings);
    const refreshToken = openSecret(current.refreshToken, key);
    // Unreadable means the client secret was reissued since this was sealed.
    if (!refreshToken) {
      await this.store.endSession(portalSessionId, authUserId);
      this.logger.log({ event: 'portal_session_ended', reason: 'stored token unreadable', authUserId });
      return { live: false };
    }

    const outcome = await this.client.refresh(settings, refreshToken);
    if (outcome.kind === 'revoked') {
      await this.store.endSession(portalSessionId, authUserId);
      this.logger.log({ event: 'portal_session_ended', reason: 'portal refused refresh', authUserId });
      return { live: false };
    }
    if (outcome.kind === 'unavailable') {
      this.logger.warn({ event: 'portal_recheck_deferred', reason: outcome.reason, authUserId });
      return { live: true, accessTtlSeconds: UNAVAILABLE_ACCESS_TTL_SECONDS };
    }

    const stored = await this.store.updateSession(portalSessionId, {
      ...current,
      refreshToken: sealSecret(outcome.refreshToken, key),
      checkedAt: Date.now(),
    });
    // Ended while the portal was being asked: a back-channel logout won.
    if (!stored) return { live: false };
    return { live: true, accessTtlSeconds: settings.recheckSeconds };
  }

  /**
   * Another renewal holds the lock and is asking the portal. Wait for its
   * answer rather than asking again.
   */
  private async followCheck(
    settings: PortalSettings,
    portalSessionId: string,
    authUserId: string,
    seen: PortalSessionRecord,
  ): Promise<PortalRenewal> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      const current = await this.store.readSession(portalSessionId);
      if (!current || current.authUserId !== authUserId) return { live: false };
      if (current.checkedAt !== seen.checkedAt) {
        const notDue = this.ttlUntilDue(settings, current);
        return { live: true, accessTtlSeconds: notDue || UNAVAILABLE_ACCESS_TTL_SECONDS };
      }
    }
    // The other renewal found the portal unavailable, or is still waiting on
    // it. Either way the session stands, and the next renewal asks again.
    return { live: true, accessTtlSeconds: UNAVAILABLE_ACCESS_TTL_SECONDS };
  }

  /**
   * Seconds until this session's next check is due, or 0 when it is due now.
   *
   * "Due" is the console's renewal margin early. The console renews a minute
   * before expiry, so a token that lives exactly until the check is due would
   * be renewed a minute short of it and carry the old check another round.
   * Asking at the console's own renewal keeps every request inside the limit.
   */
  private ttlUntilDue(settings: PortalSettings, record: PortalSessionRecord) {
    const remaining = Math.floor((record.checkedAt + settings.recheckSeconds * 1000 - Date.now()) / 1000);
    return remaining > CONSOLE_RENEWAL_MARGIN_SECONDS ? remaining : 0;
  }

  private settings() {
    return readPortalConfig().settings;
  }
}
