import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ApplicationError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { withSystemTenant, withTenant } from '../../database/tenant-context';
import { SessionService, type SessionTokens } from '../session.service';
import { isStaffAccount, STAFF_ACCOUNT_SELECT, staffOrganizationOf } from '../staff-account';
import { TokenService } from '../token.service';
import { PortalClient, PortalRefusedError, PortalUnavailableError, type PortalUserInfo } from './portal.client';
import { PORTAL_SCOPE, readPortalConfig, type PortalSettings } from './portal.config';
import { PortalSessionService } from './portal-session.service';
import { PortalStore, PortalStoreUnavailableError } from './portal.store';

/**
 * Signing in through the TR Staff Portal: the redirect out, and what happens
 * when the portal sends the person back.
 *
 * The console's own route handlers drive the browser; this does the work that
 * needs the client secret or the database, so neither ever reaches the console.
 */

/**
 * Why a portal sign-in was refused, as the console shows it.
 *
 * A fixed list: the login page turns each into its own sentence and never
 * repeats anything the portal or this API said, so a crafted callback cannot
 * put words on the page.
 */
export type PortalRefusal = 'expired' | 'denied' | 'no_access' | 'no_account' | 'unavailable';

const REFUSAL_STATUS: Record<PortalRefusal, number> = {
  expired: 400,
  denied: 400,
  no_access: 403,
  no_account: 403,
  unavailable: 503,
};

const REFUSAL_MESSAGE: Record<PortalRefusal, string> = {
  expired: 'That sign-in expired or was already used. Try again.',
  denied: 'The TR Staff Portal did not complete the sign-in. Try again.',
  no_access: 'Your TR Staff Portal account is not allowed to open this app. Ask an admin to add you.',
  no_account: 'There is no staff account here for you yet. Ask an admin to add you.',
  unavailable: 'The TR Staff Portal could not be reached. Try again in a minute.',
};

function refuse(reason: PortalRefusal) {
  return new ApplicationError(REFUSAL_STATUS[reason], 'PORTAL_SIGN_IN_REFUSED', REFUSAL_MESSAGE[reason], [
    { reason },
  ]);
}

/** Ten minutes to sign in at the portal and come back. */
const FLOW_TTL_SECONDS = 10 * 60;
const DEFAULT_RETURN_TO = '/dashboard';

/**
 * Where to send someone after signing in, from where they were going.
 *
 * Only a path on the console itself. `//evil.example` and `/\evil.example` are
 * read by browsers as another host, so anything that is not plainly one path
 * on this site falls back to the dashboard — as do the sign-in pages, which
 * would only send the person round again.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return DEFAULT_RETURN_TO;
  // Control characters, which a browser may strip to turn `/\t/evil` into `//evil`.
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f))
    return DEFAULT_RETURN_TO;
  if (/^\/(login|auth\/portal)(\/|\?|#|$)/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}

/** Compares two random strings without leaking where they first differ. */
function sameSecret(a: string, b: string) {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a === b;
}

const random = () => randomBytes(32).toString('base64url');

const ACCOUNT_SELECT = {
  id: true,
  authUserId: true,
  email: true,
  isActive: true,
  portalSubject: true,
  ...STAFF_ACCOUNT_SELECT,
} satisfies Prisma.UserProfileSelect;

type Account = Prisma.UserProfileGetPayload<{ select: typeof ACCOUNT_SELECT }>;

@Injectable()
export class PortalSignInService {
  private readonly logger = new Logger(PortalSignInService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PortalStore) private readonly store: PortalStore,
    @Inject(PortalClient) private readonly client: PortalClient,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PortalSessionService) private readonly portalSessions: PortalSessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  /** Whether the console should offer "Sign in with TR Staff Portal". */
  enabled() {
    return readPortalConfig().enabled;
  }

  /**
   * Begins a sign-in: a fresh `state` and PKCE verifier, kept server-side with
   * where the person was going, and the portal's authorize address to send
   * the browser to. The console holds only the id of this record, in an
   * httpOnly cookie.
   */
  async start(returnTo?: string) {
    const settings = this.settingsOrNotFound();
    const flowId = random();
    const state = random();
    const verifier = random();
    try {
      await this.store.saveFlow(flowId, { state, verifier, returnTo: safeReturnTo(returnTo) }, FLOW_TTL_SECONDS);
    } catch (error) {
      if (error instanceof PortalStoreUnavailableError) throw refuse('unavailable');
      throw error;
    }

    const url = new URL(settings.endpoints.authorize);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      scope: PORTAL_SCOPE,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { flowId, authorizeUrl: url.toString() };
  }

  /**
   * Finishes a sign-in when the portal sends the person back.
   *
   * In this order, and each step refuses before the next runs: the sign-in
   * record is taken (used once, whatever follows); `state` must match it
   * before any request goes to the portal; the portal must have sent a code;
   * the code is exchanged and the person read; this app must be in their
   * `apps`; and they must link to exactly one staff account here. Only then is
   * a session issued.
   */
  async complete(
    input: { flowId: string; state?: string; code?: string; error?: string },
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<SessionTokens & { returnTo: string }> {
    const settings = this.settingsOrNotFound();

    let flow;
    try {
      flow = await this.store.takeFlow(input.flowId);
    } catch (error) {
      if (error instanceof PortalStoreUnavailableError) throw refuse('unavailable');
      throw error;
    }
    if (!flow) return this.refused('expired', 'no sign-in in progress, or it was already used');
    if (!input.state || !sameSecret(input.state, flow.state))
      return this.refused('expired', 'state did not match');
    if (input.error)
      return this.refused('denied', `portal returned ${input.error.replace(/[^\w.-]/g, '').slice(0, 64)}`);
    if (!input.code) return this.refused('denied', 'portal returned no code');

    let info: PortalUserInfo;
    try {
      const portalTokens = await this.client.exchangeCode(settings, input.code, flow.verifier);
      info = await this.client.userInfo(settings, portalTokens.accessToken);
      if (!info.apps.includes(settings.appSlug))
        return this.refused('no_access', 'this app is not in the apps claim', { subject: info.sub });

      const account = await this.link(settings, info);
      const portalSessionId = this.tokens.newPortalSessionId();
      const { accessTtlSeconds } = await this.portalSessions.begin(portalSessionId, {
        authUserId: account.authUserId,
        subject: info.sub,
        refreshToken: portalTokens.refreshToken,
      });
      const session = await this.sessions.issuePortalSession(
        account.authUserId,
        portalSessionId,
        accessTtlSeconds,
        context,
      );
      this.logger.log({ event: 'portal_signed_in', authUserId: account.authUserId });
      return { ...session, returnTo: flow.returnTo };
    } catch (error) {
      if (error instanceof PortalRefusedError)
        return this.refused('denied', `portal refused ${error.status}${error.oauthError ? ` ${error.oauthError}` : ''}`);
      if (error instanceof PortalUnavailableError) return this.refused('unavailable', error.reason);
      if (error instanceof PortalStoreUnavailableError) return this.refused('unavailable', 'session store unavailable');
      throw error;
    }
  }

  /**
   * Finds the one staff account this person is.
   *
   * By `sub` when they have signed in before. Otherwise by a verified address
   * at a company domain that belongs, exactly, to one staff account — and the
   * account remembers the `sub` from then on. Anything less certain is refused
   * rather than guessed at, and an account is never created. Roles,
   * permissions and the profile are never touched: the link is the only write.
   */
  private async link(settings: PortalSettings, info: PortalUserInfo): Promise<Account> {
    const linked = await withSystemTenant(() =>
      this.prisma.userProfile.findUnique({ where: { portalSubject: info.sub }, select: ACCOUNT_SELECT }),
    );
    if (linked) {
      if (!linked.isActive) return this.refusedAccount(linked, 'account is deactivated', info);
      if (!isStaffAccount(linked)) return this.refusedAccount(linked, 'account is not a staff account', info);
      return linked;
    }

    const email = info.email ?? '';
    if (info.emailVerified !== true)
      return this.refused('no_account', 'portal email is not verified', { subject: info.sub });
    const at = email.lastIndexOf('@');
    const domain = at > 0 ? email.slice(at + 1).toLowerCase() : '';
    if (!domain || !settings.allowedDomains.includes(domain))
      return this.refused('no_account', 'email domain is not a company domain', { subject: info.sub, domain });

    // Case-insensitively, then exactly: the database's matching can call two
    // different addresses the same, and that is a lookalike, not a match.
    const candidates = await withSystemTenant(() =>
      this.prisma.userProfile.findMany({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: ACCOUNT_SELECT,
        take: 10,
      }),
    );
    const exact = candidates.filter((candidate) => candidate.email.toLowerCase() === email.toLowerCase());
    if (exact.length === 0) return this.refused('no_account', 'no account has this email', { subject: info.sub });
    if (exact.length > 1)
      return this.refused('no_account', 'more than one account has this email', { subject: info.sub });

    const account = exact[0]!;
    if (!account.isActive) return this.refusedAccount(account, 'account is deactivated', info);
    if (!isStaffAccount(account)) return this.refusedAccount(account, 'account is not a staff account', info);
    if (account.portalSubject && account.portalSubject !== info.sub)
      return this.refusedAccount(account, 'account is linked to another portal identity', info);

    // Written only where still empty, so two sign-ins racing to link the same
    // account cannot both win, and one already linked is never relinked.
    try {
      const { count } = await withSystemTenant(() =>
        this.prisma.userProfile.updateMany({
          where: { id: account.id, portalSubject: null },
          data: { portalSubject: info.sub },
        }),
      );
      if (count !== 1) return this.refusedAccount(account, 'account was linked by another sign-in', info);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return this.refusedAccount(account, 'portal identity is already linked to another account', info);
      throw error;
    }
    await this.audit(account, 'auth.portal.account_linked', { portalSubject: info.sub, by: 'verified company email' });
    this.logger.log({ event: 'portal_account_linked', authUserId: account.authUserId, subject: info.sub });
    return { ...account, portalSubject: info.sub };
  }

  /** Logged with its reason; the person sees only the refusal's own sentence. */
  private refused(reason: PortalRefusal, detail: string, extra: Record<string, unknown> = {}): never {
    this.logger.warn({ event: 'portal_sign_in_refused', reason, detail, ...extra });
    throw refuse(reason);
  }

  /** A refusal about an account that exists, which an administrator should be able to find later. */
  private async refusedAccount(account: Account, detail: string, info: PortalUserInfo): Promise<never> {
    await this.audit(account, 'auth.portal.sign_in_refused', { reason: detail, portalSubject: info.sub });
    return this.refused('no_account', detail, { subject: info.sub, authUserId: account.authUserId });
  }

  /**
   * Best effort. A failed audit write must not decide whether someone can
   * sign in, but it must be seen.
   */
  private async audit(account: Account, action: string, metadata: Prisma.InputJsonObject) {
    const organizationId = staffOrganizationOf(account);
    if (!organizationId) return;
    try {
      await withTenant(organizationId, () =>
        this.prisma.auditLog.create({
          data: {
            organizationId,
            actorUserId: account.id,
            action,
            entityType: 'UserProfile',
            entityId: account.id,
            metadata,
          },
        }),
      );
    } catch {
      this.logger.error({ event: 'portal_audit_failed', action, authUserId: account.authUserId });
    }
  }

  private settingsOrNotFound(): PortalSettings {
    const settings = readPortalConfig().settings;
    if (!settings) throw new ApplicationError(404, 'PORTAL_DISABLED', 'Sign in with TR Staff Portal is not switched on.');
    return settings;
  }
}
