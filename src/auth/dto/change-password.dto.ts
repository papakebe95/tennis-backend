import { IsString, IsStrongPassword, MaxLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsStrongPassword({
    minLength: 10,
    minLowercase: 1,
    minUppercase: 1,
    minNumbers: 1,
    minSymbols: 1,
  })
  // bcrypt only reads the first 72 bytes.
  @MaxLength(72)
  newPassword!: string;
}
