import { Inject, Injectable, Logger } from '@nestjs/common';

import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import { SessionService } from '../session.service';
import { STAFF_ACCOUNT_SELECT, staffOrganizationOf } from '../staff-account';
import { readPortalConfig } from './portal.config';
import { InvalidLogoutTokenError, PortalLogoutTokenVerifier } from './portal-logout-token';
import { PortalSessionService } from './portal-session.service';
import { PortalStore, PortalStoreUnavailableError } from './portal.store';

/**
 * The portal's back-channel logout: the portal tells this app, server to
 * server, that someone has signed out there, been deactivated, or lost access.
 *
 * Every console session the person has ends — portal sign-ins, password
 * sign-ins and "remember me" alike, since "remember me" is only a refresh token
 * kept longer. The phone is left alone: it signs in with a password the portal
 * knows nothing about, and ending it mid-walkthrough loses filmed work.
 */

/** About two a second, sustained: far above what the portal sends, far below a flood. */
const REQUESTS_PER_MINUTE = 120;

@Injectable()
export class PortalLogoutService {
  private readonly logger = new Logger(PortalLogoutService.name);
  /** Used only while Redis is unreachable, and stricter for it: each process counts the whole limit. */
  private readonly localWindows = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PortalStore) private readonly store: PortalStore,
    @Inject(PortalLogoutTokenVerifier) private readonly verifier: PortalLogoutTokenVerifier,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PortalSessionService) private readonly portalSessions: PortalSessionService,
  ) {}

  /** Counts this request; false once the caller is over the limit for this minute. */
  async admit(caller: string) {
    const window = Math.floor(Date.now() / 60_000);
    const key = `logout:${window}:${caller}`;
    let count: number;
    try {
      count = await this.store.countRequest(key, 120);
    } catch {
      if (this.localWindows.size > 10_000) this.localWindows.clear();
      count = (this.localWindows.get(key) ?? 0) + 1;
      this.localWindows.set(key, count);
    }
    return count <= REQUESTS_PER_MINUTE;
  }

  /**
   * Ends a person's console sessions, given a verified logout token.
   *
   * An invalid token changes nothing and is answered 400. A valid one for
   * someone with no account here is still a success: the portal has nothing to
   * retry, and the answer says nothing about who has an account.
   */
  async logOut(logoutToken: string) {
    const settings = readPortalConfig().settings;
    if (!settings) throw new ApplicationError(404, 'PORTAL_DISABLED', 'Sign in with TR Staff Portal is not switched on.');

    let subject: string;
    try {
      ({ subject } = await this.verifier.verify(settings, logoutToken));
    } catch (error) {
      if (!(error instanceof InvalidLogoutTokenError)) throw error;
      this.logger.warn({ event: 'portal_logout_token_refused', reason: error.reason });
      throw new ApplicationError(400, 'INVALID_LOGOUT_TOKEN', 'The logout token is not valid.');
    }

    const account = await withSystemTenant(() =>
      this.prisma.userProfile.findUnique({
        where: { portalSubject: subject },
        select: { id: true, authUserId: true, ...STAFF_ACCOUNT_SELECT },
      }),
    );
    if (!account) {
      this.logger.log({ event: 'portal_logout_unknown_subject', subject });
      return;
    }

    // Postgres first: it is the record a renewal checks, so once this has run
    // nothing can renew, whatever happens to Redis next.
    const consoleSessions = await this.sessions.revokeAllFor(account.authUserId, 'TR Staff Portal sign-out', {
      consoleOnly: true,
    });
    let portalSessions = 0;
    try {
      portalSessions = await this.portalSessions.endAllFor(account.authUserId);
    } catch (error) {
      if (!(error instanceof PortalStoreUnavailableError)) throw error;
      // The access tokens of those sessions stay usable until their next
      // renewal, at most one re-check, which the revocation above refuses.
      this.logger.warn({ event: 'portal_logout_store_unavailable', authUserId: account.authUserId });
    }
    this.logger.log({ event: 'portal_logged_out', authUserId: account.authUserId, consoleSessions, portalSessions });

    const organizationId = staffOrganizationOf(account);
    if (!organizationId) return;
    try {
      await withTenant(organizationId, () =>
        this.prisma.auditLog.create({
          data: {
            organizationId,
            actorUserId: null,
            action: 'auth.portal.backchannel_logout',
            entityType: 'UserProfile',
            entityId: account.id,
            metadata: { consoleSessionsEnded: consoleSessions, portalSessionsEnded: portalSessions },
          },
        }),
      );
    } catch {
      this.logger.error({ event: 'portal_audit_failed', action: 'auth.portal.backchannel_logout' });
    }
  }
}
