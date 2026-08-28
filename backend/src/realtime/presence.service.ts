import { Injectable } from '@nestjs/common';

interface PresenceRecord {
  /** How many sockets this account currently holds. */
  sockets: number;
  /** When the account last had a socket open, connected or not. */
  lastSeenAt: Date;
}

export interface Presence {
  isOnline: boolean;
  lastSeenAt: string | null;
}

/**
 * Who currently has the application open.
 *
 * Derived from live websocket connections rather than from a heartbeat column,
 * because the connection *is* the fact: a socket exists exactly while an app is
 * open and listening. Writing a `lastSeenAt` on every request would cost a write
 * per request to answer a question the socket already answers for free.
 *
 * **Deliberately in memory, and deliberately not persisted.** Presence is only
 * ever true of *now*; a value that survived a restart would assert that someone
 * is connected to a process that no longer exists. A restart genuinely
 * disconnects everyone, so losing the registry with the process is correct
 * rather than a limitation.
 *
 * The one real limitation: this knows about *this* instance. The deployment
 * runs a single backend container, so that is complete today — but a second
 * replica would each see only its own sockets, and presence would have to move
 * to Redis with a TTL before that happens.
 */
@Injectable()
export class PresenceService {
  private readonly accounts = new Map<string, PresenceRecord>();

  /**
   * Counted, not flagged.
   *
   * One person can hold several sockets at once — a console in two tabs, or a
   * phone reconnecting before the old socket has timed out. A boolean would let
   * the first disconnect mark them offline while they are still connected.
   */
  connected(userId: string) {
    const existing = this.accounts.get(userId);
    this.accounts.set(userId, {
      sockets: (existing?.sockets ?? 0) + 1,
      lastSeenAt: new Date(),
    });
  }

  disconnected(userId: string) {
    const existing = this.accounts.get(userId);
    if (!existing) return;
    this.accounts.set(userId, {
      sockets: Math.max(0, existing.sockets - 1),
      // Stamped on the way out, so "last seen" is when they stopped listening
      // rather than when they started.
      lastSeenAt: new Date(),
    });
  }

  presenceFor(userId: string): Presence {
    const record = this.accounts.get(userId);
    if (!record) return { isOnline: false, lastSeenAt: null };
    return {
      isOnline: record.sockets > 0,
      lastSeenAt: record.lastSeenAt.toISOString(),
    };
  }

  /** Presence for many accounts at once, for a list that would otherwise ask per row. */
  presenceForMany(userIds: readonly string[]): Record<string, Presence> {
    return Object.fromEntries(userIds.map((id) => [id, this.presenceFor(id)]));
  }

  /** Connected account ids, for tests and diagnostics. */
  onlineAccountIds() {
    return [...this.accounts.entries()]
      .filter(([, record]) => record.sockets > 0)
      .map(([id]) => id);
  }
}
