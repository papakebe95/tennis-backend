import { Transform } from 'class-transformer';
import { PhoneLabel } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePhoneDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(30)
  number!: string;

  @IsOptional()
  @IsEnum(PhoneLabel)
  label?: PhoneLabel;
}

export class UpdatePhoneDto {
  @IsEnum(PhoneLabel)
  label!: PhoneLabel;
}
