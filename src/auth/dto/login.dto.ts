import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  // Phone number (any common format, normalized server-side) or email.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(254)
  identifier?: string;

  // Older clients (the mobile app) sign in with `email`; still accepted.
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  password!: string;
}
