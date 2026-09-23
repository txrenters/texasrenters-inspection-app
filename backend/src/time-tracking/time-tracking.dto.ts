import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** The stretch of days a timesheet covers, and whose. */
export class TimesheetQueryDto {
  @IsOptional() @IsUUID() technicianId?: string;

  /** Inclusive, as a calendar day: `2026-09-01`. */
  @IsString() @MaxLength(10) from!: string;

  /** Inclusive. */
  @IsString() @MaxLength(10) to!: string;
}

/**
 * The stretch of days to fill in.
 *
 * Its own class rather than reusing the timesheet's, because that one carries
 * a technician filter this must not have: filling one person's missing hours
 * and leaving their colleagues' unread would put two different questions on
 * one page and make the totals mean different things per row.
 */
export class FillHoursDto {
  @IsString() @MaxLength(10) from!: string;
  @IsString() @MaxLength(10) to!: string;
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

/** Settling a stretch the trail could not account for. */
export class ResolveGapDto {
  /**
   * What the gap was, in words a technician would recognise: "phone died at
   * the Feldspar job, four hours from the timesheet added back".
   */
  @IsString() @MinLength(4) @MaxLength(500) resolution!: string;

  /**
   * Minutes of on-site time to credit for the gap, when the office decides the
   * work happened. Omitted, the gap is simply marked settled and nothing is
   * added -- which is the right answer when the technician was not working.
   */
  @IsOptional() @IsInt() creditedMinutes?: number;
}
