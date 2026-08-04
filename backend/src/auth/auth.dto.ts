import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_MESSAGES,
  PASSWORD_PATTERNS,
} from '@texasrenters/shared';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
