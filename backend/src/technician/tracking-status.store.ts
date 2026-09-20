import { Injectable } from '@nestjs/common';
import type { ReportedTrackingStatus, TechnicianTrackingStatus } from '@texasrenters/shared';

/**
 * How each technician's phone last said it was recording location.
 *
 * In memory, the same as presence. It describes the phone as it is now, the
 * phone repeats it every few minutes while the app is open and whenever the
 * app comes back to the foreground, and a restart of the API forgets it only
 * until the next report. A table would keep a history of permission settings
 * that nobody reads.
 *
 * Keyed by technician. The ids are the users' own UUIDs, and every read goes
 * through positions already scoped to the reader's organization.
 */
@Injectable()
export class TrackingStatusStore {
  private readonly statuses = new Map<string, ReportedTrackingStatus>();

  record(
    technicianId: string,
    status: TechnicianTrackingStatus,
    now = new Date(),
  ): ReportedTrackingStatus {
    const reported: ReportedTrackingStatus = { ...status, reportedAt: now.toISOString() };
    this.statuses.set(technicianId, reported);
    return reported;
  }

  get(technicianId: string): ReportedTrackingStatus | null {
    return this.statuses.get(technicianId) ?? null;
  }
}
