import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_MESSAGES,
  PASSWORD_PATTERNS,
} from '@texasrenters/shared';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Policy for replacing a temporary password.
 *
 * The rules themselves live in `shared` so the apps check exactly what this
 * enforces. They were written out separately before and drifted twice — the
 * API asked for twelve characters while the app checked eight, so a password
 * could pass the form and be refused here with nothing useful to say.
 *
 * Each requirement stays its own constraint so a rejection names the rule that
 * failed. The exception filter returns these strings, so they are the words
 * someone actually reads on the screen.
 */
export class ChangeRequiredPasswordDto {
  @IsString()
  @MinLength(MINIMUM_PASSWORD_LENGTH, { message: PASSWORD_MESSAGES.tooShort })
  @MaxLength(MAXIMUM_PASSWORD_LENGTH, { message: PASSWORD_MESSAGES.tooLong })
  @Matches(PASSWORD_PATTERNS.capital, { message: PASSWORD_MESSAGES.capital })
  @Matches(PASSWORD_PATTERNS.number, { message: PASSWORD_MESSAGES.number })
  @Matches(PASSWORD_PATTERNS.special, { message: PASSWORD_MESSAGES.special })
  password!: string;
}

/** Only the address; the response is identical whether or not it matches. */
export class RequestPasswordResetDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * Sign-in.
 *
 * The password carries no format rules here on purpose. This is a comparison
 * against a stored hash, not a policy check — rejecting a short password before
 * comparing would tell an anonymous caller that the stored one is longer, and
 * accounts predating a policy change must still be able to sign in and be told
 * to update. `ChangeRequiredPasswordDto` is where the policy belongs.
 */
export class SignInDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /**
   * Which handset is asking, as the handset itself reports.
   *
   * Optional because the console sends none, and because an older build will
   * not send it either. Absent simply means "unknown device", which never
   * matches an existing session and therefore behaves exactly as before.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  @IsString()
  @MaxLength(MAXIMUM_PASSWORD_LENGTH)
  password!: string;

  /**
   * Sign in here and end the session on the technician's other device.
   *
   * Absent on the first attempt. A technician who is already signed in
   * somewhere is refused with SESSION_ALREADY_ACTIVE, and the app offers this
   * as an explicit second step — so taking a handset over is a decision, not
   * something that happens silently to whoever is holding the other one.
   */
  @IsOptional()
  @IsBoolean()
  takeOverExistingSession?: boolean;
}

/**
 * A refresh or sign-out request.
 *
 * 43 characters is 32 bytes in base64url; the bound is generous either side
 * rather than exact, since the point is to reject something that cannot
 * possibly be one of our tokens before it reaches a database lookup.
 */
export class RefreshTokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}

/**
 * Redeeming a password-reset link.
 *
 * The password carries the full policy — unlike sign-in, this is where a new
 * password is chosen, so it is exactly the place the rules belong. Reuses the
 * same shared constants as ChangeRequiredPasswordDto so the form and the API
 * cannot drift apart again.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  token!: string;

  @IsString()
  @MinLength(MINIMUM_PASSWORD_LENGTH, { message: PASSWORD_MESSAGES.tooShort })
  @MaxLength(MAXIMUM_PASSWORD_LENGTH, { message: PASSWORD_MESSAGES.tooLong })
  @Matches(PASSWORD_PATTERNS.capital, { message: PASSWORD_MESSAGES.capital })
  @Matches(PASSWORD_PATTERNS.number, { message: PASSWORD_MESSAGES.number })
  @Matches(PASSWORD_PATTERNS.special, { message: PASSWORD_MESSAGES.special })
  password!: string;
}
