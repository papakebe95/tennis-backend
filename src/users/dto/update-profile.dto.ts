import { Transform } from 'class-transformer';
import {
  AvailabilityStatus,
  Backhand,
  DominantHand,
  PlayerLevel,
  Surface,
} from '@prisma/client';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
// Empty text clears an optional field.
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

// PATCH semantics: a missing key leaves the field alone; `null` clears the
// optional ones (bio, city, ...). Required fields reject `null`.
export class UpdateProfileDto {
  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  firstname?: string;

  @ValidateIf((_, v) => v !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  lastname?: string;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(300)
  bio?: string | null;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(60)
  city?: string | null;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  avatarUrl?: string | null;

  @ValidateIf((_, v) => v !== undefined)
  @IsEnum(PlayerLevel)
  level?: PlayerLevel;

  // NTRP runs 1.0 – 7.0 in half-point steps.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(1)
  @Max(7)
  ntrpRating?: number | null;

  @IsOptional()
  @IsEnum(Surface)
  preferredSurface?: Surface | null;

  @IsOptional()
  @IsEnum(DominantHand)
  dominantHand?: DominantHand | null;

  @IsOptional()
  @IsEnum(Backhand)
  backhand?: Backhand | null;

  @ValidateIf((_, v) => v !== undefined)
  @IsEnum(AvailabilityStatus)
  availabilityStatus?: AvailabilityStatus;

  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(80)
  availabilityNote?: string | null;
}
