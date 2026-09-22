import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  firstname!: string;

  @IsString()
  lastname!: string;

  // Format-checked and normalized (spacing/leading "00") in AuthService, the
  // same way CreatePhoneDto's `number` is — this only checks the shape.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(30)
  msisdn!: string;
}
