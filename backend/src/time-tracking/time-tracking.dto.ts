import { IsISO8601, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

/** A calendar day in Texas, as the console sends it: `2026-09-01`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The stretch of days a timesheet covers, and whose. */
export class TimesheetQueryDto {
  @IsOptional() @IsUUID() technicianId?: string;

  /** Inclusive, as a calendar day in Texas: `2026-09-01`. */
  @Matches(DAY) from!: string;

  /** Inclusive. */
  @Matches(DAY) to!: string;
}

/**
 * The stretch of days to read again.
 *
 * Its own class rather than reusing the timesheet's, because that one carries
 * a technician filter this must not have: reading one person's days under a
 * new rule and leaving their colleagues on the old one would make the totals
 * mean different things per row.
 */
export class RecalculateDto {
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
}

/**
 * An administrator correcting a segment.
 *
 * Both ends are required even when only one moves, because a correction that
 * says "make it end later" and one that says "it ran from here to here" read
 * the same afterwards, and the second is the one somebody can check.
 */
export class AdjustSegmentDto {
  @IsISO8601() startedAt!: string;
  @IsISO8601() endedAt!: string;

  /**
   * Why. Required, and long enough to be a sentence rather than a shrug.
   *
   * The whole point of the tracker is that the number is not somebody's
   * recollection. When a person does overrule it, the reason is what makes that
   * legible later -- to the office, and to the technician being paid from it.
   */
  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}
