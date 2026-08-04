import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Policy for replacing a temporary password.
 *
 * Each requirement is its own constraint so a rejection names the rule that
 * failed — "Include at least one number." rather than one sentence listing
 * everything. The exception filter returns these strings, so they are the words
 * a technician actually reads on the screen.
 *
 * The 72-character ceiling is bcrypt's, not a policy choice: anything past it
 * is ignored when hashed, so accepting it would be a lie.
 */
export class ChangeRequiredPasswordDto {
  @IsString()
  @MinLength(6, { message: 'Use at least 6 characters.' })
  @MaxLength(72, { message: 'Use no more than 72 characters.' })
  @Matches(/[A-Z]/, { message: 'Include at least one capital letter.' })
  @Matches(/[0-9]/, { message: 'Include at least one number.' })
  @Matches(/[^A-Za-z0-9]/, { message: 'Include at least one special character.' })
  password!: string;
}

/** Only the address; the response is identical whether or not it matches. */
export class RequestPasswordResetDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
