import { IsString, MaxLength, MinLength } from 'class-validator';

export class ChangeRequiredPasswordDto {
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}
