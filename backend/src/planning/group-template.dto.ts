import { MAX_STOPS_PER_DAY } from '@texasrenters/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MAX_TEMPLATE_GROUPS } from './group-template.service';

/** One group of a template: a technician-day, its properties in driving order. */
export class GroupTemplateGroupDto {
  @IsString() @MaxLength(80) name!: string;
  /** `#rrggbb`, as chosen on the map. */
  @IsString() @Matches(/^#[0-9a-fA-F]{6}$/) color!: string;
  /** How many properties the office meant it to hold. */
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_STOPS_PER_DAY) target!: number;
  /** The buildings, in the group's driving order. */
  @IsArray() @ArrayMaxSize(MAX_STOPS_PER_DAY) @IsUUID('all', { each: true }) buildingIds!: string[];
}

/** A whole template as the Group maker saves it: its groups replace the ones it had. */
export class GroupTemplateSaveDto {
  @IsString() @MaxLength(80) name!: string;
  /** The minutes at each property the maker estimated its days with. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(240) minutesPerProperty?: number;
  @IsArray()
  @ArrayMaxSize(MAX_TEMPLATE_GROUPS)
  @ValidateNested({ each: true })
  @Type(() => GroupTemplateGroupDto)
  groups!: GroupTemplateGroupDto[];
  /**
   * The revision this edit started from. A save over a newer one -- somebody
   * else saved in between -- is refused rather than written over theirs.
   * Absent when creating a template.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) revision?: number;
}

export class GroupTemplateActiveDto {
  @IsBoolean() active!: boolean;
}

/** A row of a groups file, to find its property by address. */
export class GroupTemplateMatchRowDto {
  @IsString() @MaxLength(200) address!: string;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string | null;
}

export class GroupTemplateMatchDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => GroupTemplateMatchRowDto)
  rows!: GroupTemplateMatchRowDto[];
}
