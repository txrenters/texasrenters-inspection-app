import { Injectable } from '@nestjs/common';

import { BUSINESS_TIME_ZONE } from '../common/business-day';
import { ApplicationError } from '../common/errors';

interface RunningBuild {
  /** "Q4 2026", for the message a second build is refused with. */
  quarter: string;
  startedAt: Date;
}

/**
 * One build of a benefit-package plan at a time, for each organization.
 *
 * A build asks Google for thousands of drive times at a paced rate, so it takes
 * minutes. Two at once write the same plan's days over each other, and share
 * one per-minute budget with Google so each takes twice as long. It happened on
 * 2026-09-16: the console's request was cut off at 30 seconds, a second click
 * started another build 44 seconds into the first, and both ran to the end.
 *
 * Held in memory. The backend runs as one process, and a restart ends a build
 * anyway, so a lock in the database would only outlive the thing it guards.
 */
@Injectable()
export class PlanBuildGuard {
  private readonly builds = new Map<string, RunningBuild>();

  /** The build running for the organization, if one is. */
  current(organizationId: string): RunningBuild | null {
    return this.builds.get(organizationId) ?? null;
  }

  /** Run `build` unless another is running for the organization, which is refused with 409. */
  async run<T>(organizationId: string, quarter: string, build: () => Promise<T>): Promise<T> {
    this.refuseWhileBuilding(organizationId);
    const entry: RunningBuild = { quarter, startedAt: new Date() };
    this.builds.set(organizationId, entry);
    try {
      return await build();
    } finally {
      if (this.builds.get(organizationId) === entry) this.builds.delete(organizationId);
    }
  }

  /** Publishing reads the very stops a build is rewriting, so it waits for the build too. */
  refuseWhileBuilding(organizationId: string) {
    const running = this.builds.get(organizationId);
    if (!running) return;
    const since = new Intl.DateTimeFormat('en-US', {
      timeZone: BUSINESS_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
    })
      .format(running.startedAt)
      // Newer ICU puts a narrow no-break space before PM; a plain one reads the same anywhere.
      .replace(/\s/gu, ' ');
    throw new ApplicationError(
      409,
      'PLAN_BUILD_RUNNING',
      `The ${running.quarter} plan is already being built, since ${since} Central. A build takes a few minutes: reload the page once it has finished.`,
    );
  }
}
