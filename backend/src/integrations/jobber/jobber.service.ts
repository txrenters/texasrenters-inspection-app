import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus } from '@prisma/client';

import { PrismaService } from '../../common/prisma.service';
import { JobberClient } from './jobber.client';
import { JobberError } from './jobber.errors';
import { JobberOAuthService } from './jobber.oauth.service';
import { JobberTokenService } from './jobber.tokens.service';
import { JobberSyncScheduler } from '../../workers/jobber-sync/jobber-sync.scheduler';

@Injectable()
export class JobberService {
  private readonly logger = new Logger(JobberService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberTokenService) private readonly tokens: JobberTokenService,
    @Inject(JobberOAuthService) private readonly oauth: JobberOAuthService,
    @Inject(JobberClient) private readonly client: JobberClient,
    @Inject(JobberSyncScheduler) private readonly scheduler: JobberSyncScheduler,
  ) {}

  /**
   * Connection state for the console.
   *
   * Selected explicitly so no ciphertext column can be added later and quietly
   * start being served. The cost of that is this list has to be kept in step
   * with what the page shows: every `lastSync*` column below was written by the
   * worker and never selected here, so the console reported "Last sync —" and
   * "Visits last read 0" against a connection that had just read 223 visits,
   * and the last-sync-failed alert could not appear at all.
   */
  async describeConnection(organizationId: string) {
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: {
        status: true,
        jobberAccountId: true,
        jobberAccountName: true,
        apiVersion: true,
        connectedAt: true,
        disconnectedAt: true,
        lastRefreshedAt: true,
        lastRefreshError: true,
        lastSyncStartedAt: true,
        lastSyncCompletedAt: true,
        lastSyncVisitCount: true,
        lastSyncError: true,
      },
    });
    if (!connection)
      return {
        status: JobberConnectionStatus.DISCONNECTED,
        jobberAccountName: null,
        schedule: this.scheduler.describeSchedule(),
      } as const;
    return {
      ...connection,
      /**
       * Reported alongside the connection because they answer one question.
       *
       * "Connected" and "syncing" are independent: the scheduler is off unless
       * three environment variables agree, so a healthy connection that imports
       * nothing is a real and previously invisible state.
       */
      schedule: this.scheduler.describeSchedule(),
      /**
       * A run in flight, from whichever side started it.
       *
       * The scheduler's own flag only covers its ticks; a sync somebody
       * launched from the console runs outside it. Comparing the timestamps
       * catches both, and is what lets the page show progress rather than a
       * stale "last sync" for the seconds a run takes.
       */
      syncInProgress:
        connection.lastSyncStartedAt !== null &&
        (connection.lastSyncCompletedAt === null ||
          connection.lastSyncStartedAt > connection.lastSyncCompletedAt) &&
        /**
         * A failed run is finished, not running.
         *
         * `lastSyncCompletedAt` is only written on success, so without this a
         * sync that threw left the console saying "Syncing now…" for ever — and
         * polling every two seconds to keep saying it. The error is cleared at
         * the start of every run, so its presence means the *last* run failed
         * rather than that some older one did.
         */
        connection.lastSyncError === null,
    };
  }

  /**
   * Finishes the consent round trip.
   *
   * The account identity is read immediately after the exchange because it is
   * the only point at which a re-authorization landing on a *different* Jobber
   * account can be caught. Letting that through would repoint the scheduling
   * source of record at another company's calendar without anything looking
   * wrong, so the previous credentials are put back and the attempt refused.
   */
  async completeAuthorization(input: { code: string; state?: string }) {
    const state = this.oauth.readState(input.state);
    const previous = await this.prisma.jobberConnection.findUnique({
      where: { organizationId: state.organizationId },
      select: {
        status: true,
        jobberAccountId: true,
        accessTokenCiphertext: true,
        accessTokenExpiresAt: true,
        refreshTokenCiphertext: true,
      },
    });
    await this.tokens.exchangeAuthorizationCode({
      organizationId: state.organizationId,
      code: input.code,
      codeVerifier: state.codeVerifier,
      connectedByUserId: state.userId,
    });
    const account = await this.client.fetchAccount(state.organizationId);
    const swapped =
      previous?.status === JobberConnectionStatus.CONNECTED &&
      previous.jobberAccountId !== null &&
      !JobberOAuthService.sameAccount(previous.jobberAccountId, account.id);
    if (swapped) {
      await this.prisma.jobberConnection.update({
        where: { organizationId: state.organizationId },
        data: {
          status: previous.status,
          accessTokenCiphertext: previous.accessTokenCiphertext,
          accessTokenExpiresAt: previous.accessTokenExpiresAt,
          refreshTokenCiphertext: previous.refreshTokenCiphertext,
        },
      });
      this.logger.warn(
        `Refused a Jobber re-authorization for ${state.organizationId}: account changed.`,
      );
      throw new JobberError(
        'This authorization is for a different Jobber account. Disconnect the current one first.',
        'JOBBER_ACCOUNT_MISMATCH',
        409,
      );
    }
    await this.prisma.jobberConnection.update({
      where: { organizationId: state.organizationId },
      data: { jobberAccountId: account.id, jobberAccountName: account.name },
    });
    return account;
  }

  /**
   * Disconnects, telling Jobber first so the app stops showing as connected
   * there — but clearing our credentials either way. A failed mutation usually
   * means the token is already dead, which is not a reason to keep storing it.
   */
  async disconnect(organizationId: string) {
    try {
      await this.client.request(
        organizationId,
        'mutation Disconnect { appDisconnect { userErrors { message } } }',
      );
    } catch {
      this.logger.warn(
        `Jobber appDisconnect failed for ${organizationId}; clearing local credentials anyway.`,
      );
    }
    await this.tokens.markDisconnected(organizationId);
    return { status: JobberConnectionStatus.DISCONNECTED } as const;
  }
}
