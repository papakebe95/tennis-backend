import { EntryType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class GenerateDrawDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(64) seedCount?: number;
  /** Reserved "Q" places; default: qualifiers the lower tables still have to send. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(64) qualifierPlaces?: number;
  /** Places left open to fill by hand. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(64) emptyPlaces?: number;
  /** A bigger draw than needed (power of two). */
  @IsOptional() @Type(() => Number) @IsIn([2, 4, 8, 16, 32, 64, 128]) size?: number;
}

export class SwapSlotsDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(127) a!: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(127) b!: number;
  /** drawVersion the screen was showing; a stale one is refused. */
  @Type(() => Number) @IsInt() @Min(0) version!: number;
}

/** Who takes a draw place: an existing entry, or a player entered on the spot. */
export class DrawEntrantDto {
  @IsOptional() @IsString() participantId?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() partnerUserId?: string;
  @IsOptional() @IsIn(Object.values(EntryType)) entryType?: EntryType;
  @IsOptional() @IsString() sourceEventId?: string;
  /** Required on a locked draw and for replacements; audited and told to the player replaced. */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) overrideReason?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) version?: number;
}
