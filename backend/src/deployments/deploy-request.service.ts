import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ApplicationError } from '../common/errors';

import {
  GithubActionsKeys,
  UnverifiedCaller,
  verifyGithubActionsToken,
  type ExpectedCaller,
} from './github-actions-token';

/**
 * The only caller whose word starts a deploy: the image workflow, run by a
 * published release, in this repository. The audience is the one the workflow
 * asks GitHub for, so a token minted for anything else is refused here.
 */
export const DEPLOY_CALLER: ExpectedCaller = {
  audience: 'texasrenters-inspection-deploy',
  repository: 'txrenters/texasrenters-inspection-app',
  workflow: 'publish-images.yml',
  eventName: 'release',
};

/** How long a run is remembered, so a retried or replayed call does not ask twice. */
const REMEMBER_RUNS_MS = 60 * 60_000;

export type DeployRequestStatus = 'REQUESTED' | 'ALREADY_REQUESTED';

/**
 * Passes "a release's images are published" from GitHub to the host.
 *
 * The backend cannot deploy anything itself, and must not be able to: it runs
 * inside the stack being replaced, with no Docker socket. All it does is drop a
 * file into `DEPLOY_REQUEST_DIR`, a directory the host shares with this
 * container, and the host's `texasrenters-update.path` unit starts the same
 * update the five-minute timer runs (scripts/deploy). That update reads the
 * newest release from GitHub itself and deploys only that, so even a request
 * that got through would ask for nothing but an early check.
 */
@Injectable()
export class DeployRequestService {
  private readonly logger = new Logger(DeployRequestService.name);
  private readonly runs = new Map<string, number>();

  constructor(@Inject(GithubActionsKeys) private readonly keys: GithubActionsKeys) {}

  async request(
    authorization: string | undefined,
  ): Promise<{ status: DeployRequestStatus; release: string }> {
    const directory = process.env.DEPLOY_REQUEST_DIR?.trim();
    if (!directory)
      throw new ApplicationError(
        503,
        'DEPLOY_REQUESTS_NOT_CONFIGURED',
        'This server does not take deploy requests.',
      );

    const token = authorization?.match(/^Bearer\s+(\S+)$/iu)?.[1];
    if (!token)
      throw new ApplicationError(
        401,
        'DEPLOY_REQUEST_UNVERIFIED',
        'A GitHub Actions token is required.',
      );

    let claims;
    try {
      claims = await verifyGithubActionsToken(token, this.keys, DEPLOY_CALLER);
    } catch (error) {
      if (error instanceof UnverifiedCaller) {
        // Why, in the log only. The caller is told nothing it could use to
        // shape a better forgery.
        this.logger.warn({ event: 'deploy_request_refused', reason: error.message });
        throw new ApplicationError(
          401,
          'DEPLOY_REQUEST_UNVERIFIED',
          'The deploy request could not be verified.',
        );
      }
      this.logger.error({
        event: 'deploy_request_keys_unavailable',
        message: error instanceof Error ? error.message : String(error),
      });
      throw new ApplicationError(
        503,
        'DEPLOY_REQUEST_KEYS_UNAVAILABLE',
        "GitHub's signing keys could not be fetched, so the request could not be verified.",
      );
    }

    const release = claims.ref.replace(/^refs\/tags\//u, '');
    const run = `${claims.run_id}-${claims.run_attempt}`;
    this.forgetOldRuns();
    if (this.runs.has(run)) return { status: 'ALREADY_REQUESTED', release };

    // Named by the run, which is digits only (checked with the token), so the
    // name cannot reach outside the directory.
    const file = join(directory, `github-run-${run}.json`);
    const body = { release, sha: claims.sha, runId: claims.run_id, runAttempt: claims.run_attempt, requestedAt: new Date(Date.now()).toISOString() };
    try {
      await writeFile(file, `${JSON.stringify(body)}\n`);
    } catch (error) {
      this.logger.error({
        event: 'deploy_request_not_written',
        code: (error as NodeJS.ErrnoException).code,
      });
      throw new ApplicationError(
        503,
        'DEPLOY_REQUESTS_NOT_CONFIGURED',
        'The deploy request could not be passed to the host.',
      );
    }

    this.runs.set(run, Date.now());
    this.logger.log({
      event: 'deploy_requested',
      release,
      sha: claims.sha,
      runId: claims.run_id,
      runAttempt: claims.run_attempt,
    });
    return { status: 'REQUESTED', release };
  }

  private forgetOldRuns() {
    for (const [run, at] of this.runs) if (Date.now() - at > REMEMBER_RUNS_MS) this.runs.delete(run);
  }
}
