import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** A calendar day in Texas, as the console sends it: `2026-09-01`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day a timesheet covers, and whose.
 *
 * One day, not a range. A range made the page fetch and draw every stretch of
 * a fortnight to show a handful of them, and its two ends could be put the
 * wrong way round -- which from Manila happened on the first morning, because
 * "today" there is already tomorrow in Texas.
 */
export class TimesheetQueryDto {
  @IsOptional() @IsUUID() technicianId?: string;

  /** A calendar day in Texas: `2026-09-01`. */
  @Matches(DAY) date!: string;
}

/**
 * The stretch of days to read again.
 *
 * Still a range, unlike the timesheet: after the rule changes the office reads
 * a month again in one go, and that is a write the server does, not a page
 * anybody has to look at. No technician filter -- reading one person's days
 * under a new rule and leaving their colleagues on the old one would make the
 * totals mean different things per row.
 */
export class RecalculateDto {
  @Matches(DAY) from!: string;
  @Matches(DAY) to!: string;
}

/**
 * An administrator correcting a technician's time at one property.
 *
 * The timesheet shows a property once per day however often the technician
 * walked in and out, so a correction is to that whole visit: every stretch
 * behind the row, sent back as the row's own list, becomes one stretch from
 * here to here.
 */
export class CorrectVisitDto {
  @IsArray()
  @ArrayMinSize(1)
  // A day has a few dozen stretches at most. This is a guard, not a limit
  // anybody is expected to reach.
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  segmentIds!: string[];

  /**
   * Both ends are required even when only one moves, because a correction that
   * says "make it end later" and one that says "it ran from here to here" read
   * the same afterwards, and the second is the one somebody can check.
   */
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
