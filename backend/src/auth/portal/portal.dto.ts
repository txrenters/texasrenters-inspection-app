import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Where the person was going. Checked again, and narrowed to a path on the console, before it is kept. */
export class PortalStartDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  returnTo?: string;
}

/**
 * What the portal sent the browser back with, as the console's callback
 * forwards it, plus the id of the sign-in it started.
 *
 * Every field is named, because the API refuses fields it does not know.
 * `error_description` is deliberately not one of them: the portal's own words
 * are never shown or kept.
 */
export class PortalCompleteDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,128}$/)
  flowId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  error?: string;
}

/** The portal's back-channel logout: one form field, a signed JWT. */
export class PortalBackchannelLogoutDto {
  // The name is the OpenID back-channel logout spec's, not ours.
  @IsString()
  @MaxLength(8192)
  logout_token!: string;
}
